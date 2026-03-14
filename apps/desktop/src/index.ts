import { ApplicationMenu, BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";
import { tryCatch } from "@orkis/shared";
import type { LspDiagnostic, OrkisRPC, WorktreeChangeCounts } from "@orkis/rpc";
import { createLspClient } from "./lsp";
import type { LspClient } from "./lsp";
import { getShellEnv } from "./shellEnv";

type OrkisRPCInstance = ReturnType<typeof BrowserView.defineRPC<OrkisRPC>>;
type OrkisWindow = BrowserWindow<OrkisRPCInstance>;

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);
const VITE_DEV_SERVER_URL = "http://localhost:5173";

const channel = await Updater.localInfo.channel();

/** dev チャンネルかつ Vite dev server が起動していれば HMR 用 URL を返す */
async function getViewUrl(): Promise<string> {
  if (channel === "dev") {
    const result = tryCatch(fetch(VITE_DEV_SERVER_URL, { method: "HEAD" }));
    if ((await result).ok) {
      console.log(`[orkis] HMR enabled: ${VITE_DEV_SERVER_URL}`);
      return VITE_DEV_SERVER_URL;
    }
  }
  return "views://main/index.html";
}

const viewUrl = await getViewUrl();
const SOCKET_PATH = `/tmp/orkis-${channel}.sock`;
const GIT_STATUS_DEBOUNCE_MS = 300;
const GIT_WATCH_POLL_MS = 500;

// --- PTY 管理 ---

interface PtyEntry {
  proc: ReturnType<typeof Bun.spawn>;
  win: OrkisWindow;
  /** PTY が起動された worktree ディレクトリ */
  worktreeDir: string;
  /** UTF-8 ストリームデコーダ（チャンク分割時のマルチバイト文字化け防止） */
  decoder: TextDecoder;
}

const ptys = new Map<number, PtyEntry>();
let nextPtyId = 0;

function spawnPty(win: OrkisWindow, cwd: string, cols: number, rows: number): number {
  const id = nextPtyId++;
  // stream: true で途中切れの UTF-8 バイト列を次のチャンクに繰り越す
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const proc = Bun.spawn([shellEnv.SHELL ?? "/bin/zsh"], {
    cwd,
    env: {
      ...shellEnv,
      // TERM 系は PTY 側で明示設定する（親の値を持ち込まない）
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "orkis",
      // CLI ツール（Claude Code 等）に OSC 8 ハイパーリンクの出力を許可する
      FORCE_HYPERLINK: "1",
      LANG: shellEnv.LANG ?? "en_US.UTF-8",
    },
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        const text = decoder.decode(data, { stream: true });
        if (text) {
          win.webview.rpc?.send.ptyData({ id, data: text });
        }
      },
      exit() {
        // 残りのバッファをフラッシュ
        const remaining = decoder.decode();
        if (remaining) {
          win.webview.rpc?.send.ptyData({ id, data: remaining });
        }
        ptys.delete(id);
        win.webview.rpc?.send.ptyExit({ id, exitCode: proc.exitCode ?? 1 });
      },
    },
  });

  ptys.set(id, { proc, win, worktreeDir: cwd, decoder });
  return id;
}

// --- セキュリティ ---

function isAllowedProtocol(raw: string): boolean {
  const result = tryCatch(() => new URL(raw));
  if (!result.ok) return false;
  return ALLOWED_PROTOCOLS.has(result.value.protocol);
}

async function resolveSecurePath(root: string, relPath: string): Promise<string> {
  const resolved = path.resolve(root, relPath);
  const real = await fsp.realpath(resolved);
  const realRoot = await fsp.realpath(root);
  const relative = path.relative(realRoot, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Access denied: path is outside workspace root");
  }
  return real;
}

/** ファイルが存在しなくてもパストラバーサルだけを防ぐチェック（git 操作用） */
function assertInsideRoot(root: string, relPath: string): void {
  const resolved = path.resolve(root, relPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Access denied: path is outside workspace root");
  }
}

// --- git ---

async function filterIgnored(entries: string[], cwd: string): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  const result = await tryCatch(
    new Response(Bun.spawn(["git", "check-ignore", ...entries], { cwd }).stdout).text(),
  );
  if (!result.ok) return new Set();
  const text = result.value;
  return new Set(text.split("\n").filter(Boolean));
}

async function getGitStatus(cwd: string): Promise<Record<string, string>> {
  const result = await tryCatch(
    new Response(Bun.spawn(["git", "status", "--porcelain=v1", "-z"], { cwd }).stdout).text(),
  );
  if (!result.ok) return {};
  const stdout = result.value;
  const statuses: Record<string, string> = {};
  const parts = stdout.split("\0");
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (!entry) {
      i++;
      continue;
    }
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (status[0] === "R" || status[0] === "C") {
      i++;
      const newPath = parts[i];
      if (newPath !== undefined) {
        statuses[newPath] = status;
      }
    } else {
      statuses[filePath] = status;
    }
    i++;
  }
  return statuses;
}

/** git status の2文字コードから変更種別ごとのファイル数を算出 */
function countChanges(statuses: Record<string, string>): WorktreeChangeCounts {
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let untracked = 0;

  for (const status of Object.values(statuses)) {
    if (status === "??") {
      untracked++;
      continue;
    }
    // worktree 側 (Y) を優先、なければ index 側 (X) を使う
    const code = status[1] !== " " ? status[1] : status[0];
    switch (code) {
      case "A":
        added++;
        break;
      case "D":
        deleted++;
        break;
      default:
        // M, R, C, T, U 等はすべて modified 扱い
        modified++;
        break;
    }
  }

  return { modified, added, deleted, untracked };
}

const WORKTREE_DIR = ".orkis/worktrees";

function generateWorktreeId(): string {
  return `wt-${crypto.randomUUID().slice(0, 8)}`;
}

async function getBranchList(cwd: string): Promise<string[]> {
  const result = await tryCatch(
    new Response(Bun.spawn(["git", "branch", "--format=%(refname:short)"], { cwd }).stdout).text(),
  );
  if (!result.ok) return [];
  return result.value.trim().split("\n").filter(Boolean);
}

async function addWorktree(
  cwd: string,
  branch?: string,
): Promise<import("@orkis/rpc").WorktreeEntry> {
  const id = generateWorktreeId();
  const wtPath = path.join(cwd, WORKTREE_DIR, id);

  if (branch) {
    assertBranchName(branch);
  }

  await fsp.mkdir(path.join(cwd, WORKTREE_DIR), { recursive: true });

  // branch 指定あり → 既存ブランチをチェックアウト、なし → 新規ブランチ作成
  const args = branch
    ? ["git", "worktree", "add", wtPath, branch]
    : ["git", "worktree", "add", "-b", id, wtPath];

  const proc = Bun.spawn(args, { cwd, stderr: "pipe" });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git worktree add failed: ${stderr.trim() || `exit code ${proc.exitCode}`}`);
  }

  // 作成した worktree の情報を取得
  const headResult = await tryCatch(
    new Response(Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd: wtPath }).stdout).text(),
  );
  const head = headResult.ok ? headResult.value.trim() : "";

  return { path: wtPath, head, branch: branch ?? id, isMain: false };
}

/** wtPath が WORKTREE_DIR 配下であることを検証する */
function assertWorktreePath(cwd: string, wtPath: string): void {
  const allowed = path.resolve(cwd, WORKTREE_DIR);
  const resolved = path.resolve(wtPath);
  if (!resolved.startsWith(allowed + path.sep) && resolved !== allowed) {
    throw new Error("Access denied: path is outside worktree directory");
  }
}

async function removeWorktree(cwd: string, wtPath: string, force?: boolean): Promise<void> {
  assertWorktreePath(cwd, wtPath);

  const args = ["git", "worktree", "remove"];
  if (force) args.push("--force");
  args.push(wtPath);

  const proc = Bun.spawn(args, { cwd, stderr: "pipe" });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git worktree remove failed: ${stderr.trim() || `exit code ${proc.exitCode}`}`);
  }
}

/** ブランチ名にシェルメタ文字が含まれていないことを検証する */
function assertBranchName(branch: string): void {
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith("-")) {
    throw new Error("Invalid branch name");
  }
}

async function deleteBranch(cwd: string, branch: string): Promise<void> {
  assertBranchName(branch);

  const proc = Bun.spawn(["git", "branch", "-D", "--", branch], { cwd, stderr: "pipe" });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git branch delete failed: ${stderr.trim() || `exit code ${proc.exitCode}`}`);
  }
}

async function getWorktreeList(cwd: string): Promise<import("@orkis/rpc").WorktreeEntry[]> {
  const result = await tryCatch(
    new Response(Bun.spawn(["git", "worktree", "list", "--porcelain"], { cwd }).stdout).text(),
  );
  if (!result.ok) return [];

  const entries: import("@orkis/rpc").WorktreeEntry[] = [];
  const blocks = result.value.trim().split("\n\n");
  let isFirst = true;

  for (const block of blocks) {
    const lines = block.split("\n");
    let wtPath = "";
    let head = "";
    let branch: string | undefined;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length, "HEAD ".length + 7);
      } else if (line.startsWith("branch ")) {
        // refs/heads/main → main
        branch = line.slice("branch ".length).replace("refs/heads/", "");
      }
    }

    if (wtPath) {
      entries.push({ path: wtPath, head, branch, isMain: isFirst });
    }
    isFirst = false;
  }

  return entries;
}

/** 各 worktree の git status を並列取得して changeCounts を付与する */
async function attachChangeCounts(
  entries: import("@orkis/rpc").WorktreeEntry[],
): Promise<import("@orkis/rpc").WorktreeEntry[]> {
  await Promise.all(
    entries.map(async (entry) => {
      const statuses = await getGitStatus(entry.path);
      entry.changeCounts = countChanges(statuses);
    }),
  );
  return entries;
}

// --- ファイルサーバー ---

/** ウィンドウごとの UUID → ルートディレクトリ */
const fileServerDirs = new Map<string, string>();

const fileServer = Bun.serve({
  hostname: "localhost",
  port: 0,
  async fetch(req) {
    // GET/HEAD 以外は拒否
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const windowId = segments[0];
    if (!windowId) return new Response("Not Found", { status: 404 });

    const dir = fileServerDirs.get(windowId);
    if (!dir) return new Response("Forbidden", { status: 403 });

    const source = segments[1];
    const decodeResult = tryCatch(() => decodeURIComponent(segments.slice(2).join("/")));
    if (!decodeResult.ok) return new Response("Bad Request", { status: 400 });
    const relPath = decodeResult.value;
    if (!relPath) return new Response("Not Found", { status: 404 });

    const headers = {
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    } as Record<string, string>;

    // 拡張子から MIME タイプを推定
    const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = Bun.file(`dummy.${ext}`).type;
    headers["Content-Type"] = mimeType;

    // /{windowId}/git/{relPath} — git show HEAD:path でファイルを返す
    if (source === "git") {
      const insideResult = tryCatch(() => assertInsideRoot(dir, relPath));
      if (!insideResult.ok) return new Response("Forbidden", { status: 403 });
      const proc = Bun.spawn(["git", "show", `HEAD:${relPath}`], { cwd: dir });
      const bufResult = await tryCatch(new Response(proc.stdout).arrayBuffer());
      await proc.exited;
      if (!bufResult.ok || proc.exitCode !== 0) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(bufResult.value, { headers });
    }

    // /{windowId}/fs/{relPath} — ファイルシステムから直接返す
    if (source === "fs") {
      const pathResult = await tryCatch(resolveSecurePath(dir, relPath));
      if (!pathResult.ok) return new Response("Forbidden", { status: 403 });
      return new Response(Bun.file(pathResult.value), { headers });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[file-server] listening on http://localhost:${fileServer.port}`);

// --- LSP 管理 ---

/** ウィンドウごとに複数の LSP クライアント（tsgo + vue）を管理 */
const windowLspClients = new Map<OrkisWindow, LspClient[]>();

/** プロジェクトの node_modules から tsgo ネイティブバイナリを探す */
async function resolveTsgoPath(projectDir: string): Promise<string | undefined> {
  const packageName = `@typescript/native-preview-${process.platform}-${process.arch}`;

  // 直接パス（npm / yarn hoisted）
  const directPath = path.join(projectDir, "node_modules", packageName, "lib", "tsgo");
  if (fs.existsSync(directPath)) return directPath;

  // pnpm .pnpm 配下
  const pnpmBase = path.join(projectDir, "node_modules", ".pnpm");
  const prefix = `@typescript+native-preview-${process.platform}-${process.arch}@`;
  const entriesResult = await tryCatch(fsp.readdir(pnpmBase));
  if (entriesResult.ok) {
    for (const entry of entriesResult.value) {
      if (entry.startsWith(prefix)) {
        const candidate = path.join(pnpmBase, entry, "node_modules", packageName, "lib", "tsgo");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  return undefined;
}

/**
 * vue-language-server のエントリポイントと tsdk パスを探す。
 * pnpm モノレポでは .pnpm はルートの node_modules にのみ存在する。
 */
interface VueLspPaths {
  serverPath: string;
  tsdkPath: string;
  /** @vue/typescript-plugin の親 node_modules ディレクトリ（tsserver --pluginProbeLocations 用） */
  pluginProbeLocation: string;
}

function resolveVueLspPaths(projectRoot: string, packageDir: string): VueLspPaths | undefined {
  const prefix = "@vue+language-server@";

  // pnpm: ルートの node_modules/.pnpm から探す
  const pnpmBase = path.join(projectRoot, "node_modules", ".pnpm");
  console.log(`[lsp:vue/resolve] pnpmBase: ${pnpmBase}`);

  let serverPath: string | undefined;

  const entriesResult = tryCatch(() => fs.readdirSync(pnpmBase));
  if (entriesResult.ok) {
    const matchingEntries = entriesResult.value.filter((e) => e.startsWith(prefix));
    console.log(`[lsp:vue/resolve] matching entries: ${matchingEntries.join(", ") || "(none)"}`);

    for (const entry of matchingEntries) {
      const candidate = path.join(
        pnpmBase,
        entry,
        "node_modules",
        "@vue",
        "language-server",
        "bin",
        "vue-language-server.js",
      );
      if (fs.existsSync(candidate)) {
        serverPath = candidate;
        break;
      }
    }
  }

  // パッケージの node_modules から直接探す（hoisted の場合）
  if (!serverPath) {
    const directPath = path.join(
      packageDir,
      "node_modules",
      "@vue",
      "language-server",
      "bin",
      "vue-language-server.js",
    );
    console.log(`[lsp:vue/resolve] direct: ${directPath}, exists: ${fs.existsSync(directPath)}`);
    if (fs.existsSync(directPath)) {
      serverPath = directPath;
    }
  }

  if (!serverPath) {
    console.log("[lsp:vue/resolve] server not found");
    return undefined;
  }
  console.log(`[lsp:vue/resolve] serverPath: ${serverPath}`);

  // tsdk パス（typescript/lib ディレクトリ）— パッケージの node_modules から探す
  const tsdkPath = path.join(packageDir, "node_modules", "typescript", "lib");
  const tsdkExists = fs.existsSync(path.join(tsdkPath, "typescript.js"));
  console.log(`[lsp:vue/resolve] tsdk: ${tsdkPath}, exists: ${tsdkExists}`);
  if (!tsdkExists) return undefined;

  // @vue/typescript-plugin のパスを探す（tsserver --pluginProbeLocations 用）
  const pluginPrefix = "@vue+typescript-plugin@";
  let pluginProbeLocation: string | undefined;

  if (entriesResult.ok) {
    for (const entry of entriesResult.value) {
      if (entry.startsWith(pluginPrefix)) {
        const candidate = path.join(pnpmBase, entry, "node_modules");
        const pluginIndex = path.join(candidate, "@vue", "typescript-plugin", "index.js");
        if (fs.existsSync(pluginIndex)) {
          pluginProbeLocation = candidate;
          break;
        }
      }
    }
  }

  // hoisted の場合
  if (!pluginProbeLocation) {
    const directPlugin = path.join(
      packageDir,
      "node_modules",
      "@vue",
      "typescript-plugin",
      "index.js",
    );
    if (fs.existsSync(directPlugin)) {
      pluginProbeLocation = path.join(packageDir, "node_modules");
    }
  }

  if (!pluginProbeLocation) {
    console.log("[lsp:vue/resolve] @vue/typescript-plugin not found");
    return undefined;
  }
  console.log(`[lsp:vue/resolve] pluginProbeLocation: ${pluginProbeLocation}`);

  return { serverPath, tsdkPath, pluginProbeLocation };
}

// --- ウィンドウ管理 ---

/** ウィンドウ → UUID */
const windowIds = new Map<OrkisWindow, string>();
const windowDirs = new Map<OrkisWindow, string>();
/** CLI からの open 時に window を再利用するための repo root → window マッピング */
const windowRepoRoots = new Map<OrkisWindow, string>();
/** switchDir の世代管理。stale な非同期結果を捨てるために使う */
const windowSwitchGen = new Map<OrkisWindow, number>();

// git status デバウンス
const gitStatusTimers = new Map<OrkisWindow, ReturnType<typeof setTimeout>>();
const gitStatusInFlight = new Set<OrkisWindow>();
const gitStatusNeedsRerun = new Set<OrkisWindow>();

function scheduleGitStatusUpdate(win: OrkisWindow, root: string) {
  const existing = gitStatusTimers.get(win);
  if (existing) clearTimeout(existing);

  const gen = windowSwitchGen.get(win) ?? 0;

  const timer = setTimeout(async () => {
    gitStatusTimers.delete(win);

    if (gitStatusInFlight.has(win)) {
      gitStatusNeedsRerun.add(win);
      return;
    }

    gitStatusInFlight.add(win);
    try {
      const statuses = await getGitStatus(root);
      // 世代が変わっていたら stale な結果を捨てる
      if ((windowSwitchGen.get(win) ?? 0) !== gen) return;
      win.webview.rpc?.send.gitStatusChange({ statuses });
    } finally {
      gitStatusInFlight.delete(win);
      if (gitStatusNeedsRerun.has(win)) {
        gitStatusNeedsRerun.delete(win);
        scheduleGitStatusUpdate(win, root);
      }
    }
  }, GIT_STATUS_DEBOUNCE_MS);

  gitStatusTimers.set(win, timer);
}

// ファイル監視
const windowFsWatchers = new Map<OrkisWindow, fs.FSWatcher>();
const windowGitWatchedFiles = new Map<OrkisWindow, string[]>();

/** linked worktree 対応: `.git` がファイル（gitdir: ...）の場合に実際の git ディレクトリを解決 */
async function resolveGitDir(root: string): Promise<string> {
  const result = await tryCatch(
    new Response(Bun.spawn(["git", "rev-parse", "--git-dir"], { cwd: root }).stdout).text(),
  );
  if (!result.ok) return path.join(root, ".git");
  const gitDir = result.value.trim();
  return path.isAbsolute(gitDir) ? gitDir : path.resolve(root, gitDir);
}

function startWatching(win: OrkisWindow, root: string) {
  // ワークスペースのファイル監視（recursive, macOS）
  const watcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    // .git 内部の変更は無視（git 監視は別途行う）
    if (filename.startsWith(".git/") || filename.startsWith(".git\\")) return;
    // node_modules の変更は無視
    if (filename.startsWith("node_modules/") || filename.startsWith("node_modules\\")) return;

    const relDir = path.dirname(filename);
    win.webview.rpc?.send.fsChange({ relDir });
    scheduleGitStatusUpdate(win, root);

    // TS/Vue ファイルの変更を LSP に通知
    if (/\.[tj]sx?$|\.vue$/.test(filename)) {
      const clients = windowLspClients.get(win);
      if (clients) {
        const gen = windowSwitchGen.get(win) ?? 0;
        void (async () => {
          // 世代が変わっていたら stale な通知を捨てる
          if ((windowSwitchGen.get(win) ?? 0) !== gen) return;
          const absPath = path.join(root, filename);
          const fileResult = await tryCatch(fsp.readFile(absPath, "utf-8"));
          if ((windowSwitchGen.get(win) ?? 0) !== gen) return;
          for (const lsp of clients) {
            // プロジェクトルートからの相対パスを各 LSP の rootDir からの相対パスに変換
            const lspRelPath = path.relative(lsp.rootDir, absPath);
            if (lspRelPath.startsWith("..")) continue; // この LSP の管轄外
            if (fileResult.ok) {
              lsp.didChange(lspRelPath, fileResult.value);
            } else {
              lsp.didClose(lspRelPath);
            }
          }
          if (!fileResult.ok) {
            win.webview.rpc?.send.lspDiagnostics({ relPath: filename, diagnostics: [] });
          }
        })();
      }
    }
  });

  windowFsWatchers.set(win, watcher);

  // .git 関連ファイルの監視（linked worktree では .git がファイルなので git rev-parse で解決）
  void (async () => {
    const gitDir = await resolveGitDir(root);
    const indexPath = path.join(gitDir, "index");
    const headPath = path.join(gitDir, "HEAD");

    function resolveCurrentRefPath(): string | undefined {
      try {
        const headContent = fs.readFileSync(headPath, "utf-8").trim();
        if (headContent.startsWith("ref: ")) {
          return path.join(gitDir, headContent.slice(5));
        }
      } catch {
        // detached HEAD 等
      }
      return undefined;
    }

    let currentRefPath = resolveCurrentRefPath();

    function syncGitWatchedFiles() {
      const files = [indexPath, headPath];
      if (currentRefPath) files.push(currentRefPath);
      windowGitWatchedFiles.set(win, files);
    }

    function updateRefWatch() {
      const newRefPath = resolveCurrentRefPath();
      if (newRefPath === currentRefPath) return;

      if (currentRefPath) {
        fs.unwatchFile(currentRefPath);
      }
      currentRefPath = newRefPath;
      if (currentRefPath) {
        fs.watchFile(currentRefPath, { interval: GIT_WATCH_POLL_MS }, () => {
          scheduleGitStatusUpdate(win, root);
        });
      }
      syncGitWatchedFiles();
    }

    fs.watchFile(indexPath, { interval: GIT_WATCH_POLL_MS }, () => {
      scheduleGitStatusUpdate(win, root);
    });

    fs.watchFile(headPath, { interval: GIT_WATCH_POLL_MS }, () => {
      updateRefWatch();
      scheduleGitStatusUpdate(win, root);
    });

    if (currentRefPath) {
      fs.watchFile(currentRefPath, { interval: GIT_WATCH_POLL_MS }, () => {
        scheduleGitStatusUpdate(win, root);
      });
    }
    syncGitWatchedFiles();
  })();
}

function stopWatching(win: OrkisWindow) {
  const watcher = windowFsWatchers.get(win);
  if (watcher) {
    watcher.close();
    windowFsWatchers.delete(win);
  }
  const watchedFiles = windowGitWatchedFiles.get(win);
  if (watchedFiles) {
    for (const filePath of watchedFiles) {
      fs.unwatchFile(filePath);
    }
    windowGitWatchedFiles.delete(win);
  }
  const timer = gitStatusTimers.get(win);
  if (timer) {
    clearTimeout(timer);
    gitStatusTimers.delete(win);
  }
  gitStatusInFlight.delete(win);
  gitStatusNeedsRerun.delete(win);
}

// --- 非アクティブ worktree 監視 ---

interface WorktreeWatchEntry {
  /** ワークツリー全体の recursive watcher */
  fsWatcher: fs.FSWatcher;
  /** .git/index の watchFile パス（unwatchFile 用） */
  gitIndexPath: string;
}

/** ウィンドウごとの非アクティブ worktree 監視 */
const windowWorktreeWatchers = new Map<OrkisWindow, Map<string, WorktreeWatchEntry>>();
const wtChangeTimers = new Map<OrkisWindow, ReturnType<typeof setTimeout>>();
/** syncWorktreeWatchers の世代管理（並行実行で stale な結果を破棄するため） */
const wtSyncGen = new Map<OrkisWindow, number>();

/** 非アクティブ worktree でファイル変更があったことをデバウンスして通知 */
function scheduleWorktreeChangeNotify(win: OrkisWindow) {
  const existing = wtChangeTimers.get(win);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    wtChangeTimers.delete(win);
    win.webview.rpc?.send.worktreeChange();
  }, GIT_STATUS_DEBOUNCE_MS);

  wtChangeTimers.set(win, timer);
}

/**
 * 非アクティブ worktree の fs.watch を同期する。
 * アクティブ worktree は既存の startWatching が担当するため除外する。
 * 世代管理により、並行呼び出し時は最新の呼び出しのみが反映される。
 */
async function syncWorktreeWatchers(win: OrkisWindow, repoRoot: string, activeDir: string) {
  const gen = (wtSyncGen.get(win) ?? 0) + 1;
  wtSyncGen.set(win, gen);

  const entries = await getWorktreeList(repoRoot);

  // 世代が変わっていたら後続の呼び出しに任せる
  if (wtSyncGen.get(win) !== gen) return;

  const activeReal = await tryCatch(fsp.realpath(activeDir));
  const activePath = activeReal.ok ? activeReal.value : activeDir;

  const existing = windowWorktreeWatchers.get(win) ?? new Map<string, WorktreeWatchEntry>();
  const desiredPaths = new Set<string>();

  for (const entry of entries) {
    const entryReal = await tryCatch(fsp.realpath(entry.path));
    const entryPath = entryReal.ok ? entryReal.value : entry.path;

    // アクティブ worktree は既存の startWatching が担当
    if (entryPath === activePath) continue;
    desiredPaths.add(entryPath);

    // 既に監視中ならスキップ
    if (existing.has(entryPath)) continue;

    // ワークツリー全体の recursive watcher
    const watchResult = tryCatch(() =>
      fs.watch(entryPath, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (filename.startsWith(".git/") || filename.startsWith(".git\\")) return;
        if (filename.startsWith("node_modules/") || filename.startsWith("node_modules\\")) return;
        scheduleWorktreeChangeNotify(win);
      }),
    );

    if (!watchResult.ok) continue;

    // .git/index の監視（git add / commit / reset 等の検知用）
    const gitDir = await resolveGitDir(entryPath);
    const gitIndexPath = path.join(gitDir, "index");
    fs.watchFile(gitIndexPath, { interval: GIT_WATCH_POLL_MS }, () => {
      scheduleWorktreeChangeNotify(win);
    });

    existing.set(entryPath, { fsWatcher: watchResult.value, gitIndexPath });
  }

  // 不要な監視を停止（削除された worktree やアクティブに切り替わった worktree）
  for (const [wtPath, watchEntry] of existing) {
    if (!desiredPaths.has(wtPath)) {
      watchEntry.fsWatcher.close();
      fs.unwatchFile(watchEntry.gitIndexPath);
      existing.delete(wtPath);
    }
  }

  windowWorktreeWatchers.set(win, existing);
}

function stopWorktreeWatchers(win: OrkisWindow) {
  const watchers = windowWorktreeWatchers.get(win);
  if (watchers) {
    for (const watchEntry of watchers.values()) {
      watchEntry.fsWatcher.close();
      fs.unwatchFile(watchEntry.gitIndexPath);
    }
    windowWorktreeWatchers.delete(win);
  }
  const timer = wtChangeTimers.get(win);
  if (timer) {
    clearTimeout(timer);
    wtChangeTimers.delete(win);
  }
  wtSyncGen.delete(win);
}

/** ウィンドウ close 時に関連リソースをすべて解放する */
function cleanupWindow(win: OrkisWindow) {
  stopWatching(win);
  stopWorktreeWatchers(win);
  const windowId = windowIds.get(win);
  if (windowId) fileServerDirs.delete(windowId);
  windowIds.delete(win);
  windowDirs.delete(win);
  windowRepoRoots.delete(win);
  windowSwitchGen.delete(win);
  // このウィンドウが所有する PTY をすべて kill
  for (const [id, entry] of ptys) {
    if (entry.win === win) {
      entry.proc.kill();
      ptys.delete(id);
    }
  }
  // LSP クライアントをシャットダウン
  const clients = windowLspClients.get(win);
  if (clients) {
    windowLspClients.delete(win);
    for (const lsp of clients) {
      void lsp.shutdown();
    }
  }
}

// --- ウィンドウ作成 ---

function createWindowWithRPC(dir: string): OrkisWindow {
  let win: OrkisWindow;

  /** worktree/branch 管理用（固定） */
  const repoRootDir = dir;
  /** ファイル操作用（switchDir で切り替え可能） */
  let currentDir = dir;

  const rpc: OrkisRPCInstance = BrowserView.defineRPC<OrkisRPC>({
    handlers: {
      requests: {
        ptySpawn: async ({ cols, rows }) => {
          // realpath で正規化して worktreeDir の一貫性を保つ
          const realCwd = await fsp.realpath(currentDir);
          return spawnPty(win, realCwd, cols, rows);
        },
        fsReadDir: async ({ relPath }) => {
          const absolutePath = await resolveSecurePath(currentDir, relPath);
          const entries = await fsp.readdir(absolutePath, { withFileTypes: true });
          const visibleEntries = entries.filter((e) => e.name !== ".git");
          const names = visibleEntries.map((e) => e.name);
          const ignored = await filterIgnored(names, absolutePath);

          return Promise.all(
            visibleEntries.map(async (entry) => {
              let isDirectory = entry.isDirectory();
              // Bun の readdir はシンボリックリンクで isDirectory() が false を返すため stat で確認
              if (!isDirectory && entry.isSymbolicLink()) {
                const statResult = await tryCatch(fsp.stat(path.join(absolutePath, entry.name)));
                if (statResult.ok) {
                  isDirectory = statResult.value.isDirectory();
                }
              }
              return {
                name: entry.name,
                isDirectory,
                isIgnored: ignored.has(entry.name),
              };
            }),
          );
        },
        fsReadFile: async ({ relPath }) => {
          const absolutePath = await resolveSecurePath(currentDir, relPath);
          const file = Bun.file(absolutePath);
          const MAX_FILE_SIZE = 1024 * 1024; // 1MB
          if (file.size > MAX_FILE_SIZE) {
            return { content: "", isBinary: true };
          }
          // NUL バイトの有無でバイナリ判定（git と同じ方式）
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.includes(0x00)) {
            return { content: "", isBinary: true };
          }
          const content = new TextDecoder().decode(bytes);
          return { content, isBinary: false };
        },
        gitShowFile: async ({ relPath }) => {
          assertInsideRoot(currentDir, relPath);
          const proc = Bun.spawn(["git", "show", `HEAD:${relPath}`], { cwd: currentDir });
          const result = await tryCatch(new Response(proc.stdout).arrayBuffer());
          await proc.exited;
          if (!result.ok || proc.exitCode !== 0) {
            return { content: "", isBinary: true };
          }
          const bytes = new Uint8Array(result.value);
          if (bytes.includes(0x00)) {
            return { content: "", isBinary: true };
          }
          return { content: new TextDecoder().decode(bytes), isBinary: false };
        },
        gitDiffFile: async ({ relPath }) => {
          assertInsideRoot(currentDir, relPath);
          const result = await tryCatch(
            new Response(
              Bun.spawn(["git", "diff", "HEAD", "--", relPath], { cwd: currentDir }).stdout,
            ).text(),
          );
          if (!result.ok) return "";
          return result.value;
        },
        gitStatus: () => getGitStatus(currentDir),
        gitWorktreeList: async () => attachChangeCounts(await getWorktreeList(repoRootDir)),
        gitBranchList: () => getBranchList(repoRootDir),
        gitWorktreeAdd: async ({ branch }) => {
          const entry = await addWorktree(repoRootDir, branch);
          void syncWorktreeWatchers(win, repoRootDir, currentDir);
          return entry;
        },
        gitWorktreeRemove: async ({ path: wtPath, force }) => {
          const wtReal = await fsp.realpath(wtPath);
          await removeWorktree(repoRootDir, wtPath, force);
          // 削除成功後に worktree の PTY を kill する
          for (const [id, entry] of ptys) {
            if (entry.win === win && entry.worktreeDir === wtReal) {
              entry.proc.kill();
              ptys.delete(id);
            }
          }
          void syncWorktreeWatchers(win, repoRootDir, currentDir);
        },
        gitBranchDelete: ({ branch }) => deleteBranch(repoRootDir, branch),
        switchDir: async ({ dir: targetDir }) => {
          // バリデーション: worktree list に含まれるパスのみ許可
          const worktrees = await getWorktreeList(repoRootDir);
          const targetReal = await fsp.realpath(targetDir);
          const validEntry = await (async () => {
            for (const wt of worktrees) {
              const wtReal = await tryCatch(fsp.realpath(wt.path));
              if (wtReal.ok && wtReal.value === targetReal) return wt;
            }
            return undefined;
          })();
          if (!validEntry) {
            throw new Error("Access denied: dir is not a known worktree");
          }

          // 世代を進めて stale event を無効化
          const gen = (windowSwitchGen.get(win) ?? 0) + 1;
          windowSwitchGen.set(win, gen);

          // 既存 LSP を shutdown（再起動はしない）
          const clients = windowLspClients.get(win);
          if (clients) {
            windowLspClients.delete(win);
            for (const lsp of clients) {
              void lsp.shutdown();
            }
          }

          // ディレクトリを切り替え
          currentDir = targetReal;

          // ファイル監視を付け替え
          stopWatching(win);
          startWatching(win, currentDir);

          // Map を更新
          const windowId = windowIds.get(win) ?? "";
          windowDirs.set(win, currentDir);
          fileServerDirs.set(windowId, currentDir);

          // 初回 git status をプッシュ
          scheduleGitStatusUpdate(win, currentDir);

          // 非アクティブ worktree の監視を再同期（アクティブが変わったため）
          void syncWorktreeWatchers(win, repoRootDir, currentDir);

          return {
            dir: currentDir,
            fileServerBaseUrl: `http://localhost:${fileServer.port}/${windowId}`,
          };
        },
      },
      messages: {
        ptyWrite: ({ id, data }) => {
          const entry = ptys.get(id);
          if (entry?.win === win) entry.proc.terminal?.write(data);
        },
        ptyResize: ({ id, cols, rows }) => {
          const entry = ptys.get(id);
          if (entry?.win === win) entry.proc.terminal?.resize(cols, rows);
        },
        ptyKill: ({ id }) => {
          const entry = ptys.get(id);
          if (entry?.win === win) {
            entry.proc.kill();
            ptys.delete(id);
          }
        },
        openExternal: ({ url }) => {
          if (isAllowedProtocol(url)) {
            Utils.openExternal(url);
          }
        },
        rendererReady: () => {
          console.log("[orkis] rendererReady received, sending orkisOpen:", currentDir);
          const windowId = windowIds.get(win) ?? "";
          win.webview.rpc?.send.orkisOpen({
            dir: currentDir,
            fileServerBaseUrl: `http://localhost:${fileServer.port}/${windowId}`,
            channel,
          });

          // 非アクティブ worktree の監視を開始
          void syncWorktreeWatchers(win, repoRootDir, currentDir);

          // webview 準備完了後に LSP を起動
          void (async () => {
            const clients: LspClient[] = [];
            const gen = windowSwitchGen.get(win) ?? 0;
            const diagCallback = (
              source: string,
              relPath: string,
              diagnostics: LspDiagnostic[],
            ) => {
              // 世代が変わっていたら stale な診断を捨てる
              if ((windowSwitchGen.get(win) ?? 0) !== gen) return;
              if (diagnostics.length > 0) {
                console.log(`[diag:${source}] ${relPath}: ${diagnostics.length} items`);
              }
              win.webview.rpc?.send.lspDiagnostics({ relPath, diagnostics });
            };

            // tsgo（TS/JS 用）
            const tsgoPath = await resolveTsgoPath(repoRootDir);
            if (tsgoPath) {
              clients.push(
                createLspClient({
                  rootDir: repoRootDir,
                  server: { kind: "tsgo", binaryPath: tsgoPath },
                  onDiagnostics: (relPath, diags) => diagCallback("tsgo", relPath, diags),
                  onError: (msg) => console.error(`[lsp:tsgo] ${msg}`),
                }),
              );
            }

            // Vue Language Server（Vue SFC 用、apps/renderer をルートにする）
            const rendererDir = path.join(repoRootDir, "apps", "renderer");
            console.log(`[lsp:vue] rendererDir: ${rendererDir}`);
            const vuePaths = resolveVueLspPaths(repoRootDir, rendererDir);
            console.log(`[lsp:vue] resolved paths:`, vuePaths ?? "not found");
            if (vuePaths) {
              console.log(`[lsp:vue] server: ${vuePaths.serverPath}, tsdk: ${vuePaths.tsdkPath}`);
              const RENDERER_PREFIX = "apps/renderer/";
              clients.push(
                createLspClient({
                  rootDir: rendererDir,
                  server: {
                    kind: "vue",
                    serverPath: vuePaths.serverPath,
                    tsdkPath: vuePaths.tsdkPath,
                    pluginProbeLocation: vuePaths.pluginProbeLocation,
                  },
                  onDiagnostics: (relPath, diagnostics) => {
                    diagCallback("vue", `${RENDERER_PREFIX}${relPath}`, diagnostics);
                  },
                  onError: (msg) => console.error(`[lsp:vue] ${msg}`),
                }),
              );
            }

            if (clients.length === 0) {
              console.log("[lsp] no LSP servers found, skipping");
              return;
            }

            windowLspClients.set(win, clients);
            await Promise.all(clients.map((lsp) => lsp.scanProject()));
          })();
        },
      },
    },
  });

  win = new BrowserWindow({
    title: "orkis",
    url: viewUrl,
    frame: { width: 1200, height: 800, x: 100, y: 100 },
    rpc,
  });

  win.on("close", () => {
    cleanupWindow(win);
  });

  return win;
}

// --- ソケット通信 ---

interface HookMessage {
  type: "hook";
  event: "running" | "done" | "needs-input";
  payload: Record<string, unknown>;
}

interface OpenMessage {
  type: "open";
  dir: string;
  file?: string;
}

type OrkisMessage = HookMessage | OpenMessage;

function findWindowByDir(dir: string): OrkisWindow | undefined {
  for (const [win, repoRoot] of windowRepoRoots) {
    if (repoRoot === dir) return win;
  }
  return undefined;
}

function handleSocketMessage(message: OrkisMessage) {
  switch (message.type) {
    case "hook": {
      console.log(`[orkis] hook: ${message.event}`, message.payload);
      // 最初のウィンドウに送信
      const firstWin = windowDirs.keys().next().value;
      if (firstWin) {
        firstWin.webview.rpc?.send.orkisHook({
          event: message.event,
          payload: message.payload,
        });
      }
      break;
    }
    case "open": {
      console.log(`[orkis] open: dir=${message.dir}, file=${message.file ?? "(none)"}`);
      const existing = findWindowByDir(message.dir);
      if (existing) {
        const existingId = windowIds.get(existing) ?? "";
        existing.webview.rpc?.send.orkisOpen({
          dir: message.dir,
          file: message.file,
          fileServerBaseUrl: `http://localhost:${fileServer.port}/${existingId}`,
          channel,
        });
        break;
      }
      const newWin = createWindowWithRPC(message.dir);
      const windowId = crypto.randomUUID();
      windowIds.set(newWin, windowId);
      fileServerDirs.set(windowId, message.dir);
      windowDirs.set(newWin, message.dir);
      windowRepoRoots.set(newWin, message.dir);
      windowSwitchGen.set(newWin, 0);
      startWatching(newWin, message.dir);
      break;
    }
  }
}

function setupSocketServer(): net.Server {
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  const server = net.createServer((connection) => {
    let buffer = "";

    connection.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") continue;
        const result = tryCatch(() => JSON.parse(line) as OrkisMessage);
        if (!result.ok) {
          console.error("[socket] invalid JSON:", line);
          continue;
        }
        handleSocketMessage(result.value);
      }
    });
  });

  server.listen(SOCKET_PATH, () => {
    console.log(`[socket] listening on ${SOCKET_PATH}`);
  });

  server.on("error", (err) => {
    console.error("[socket] server error:", err);
  });

  return server;
}

// --- シングルインスタンス制御 ---

async function isAlreadyRunning(): Promise<boolean> {
  if (!fs.existsSync(SOCKET_PATH)) return false;
  return new Promise((resolve) => {
    const conn = net.createConnection(SOCKET_PATH, () => {
      // 接続成功 = 既存インスタンスが存在
      conn.destroy();
      resolve(true);
    });
    conn.on("error", () => {
      // 接続失敗 = 残骸ソケット
      resolve(false);
    });
  });
}

if (await isAlreadyRunning()) {
  console.log("[orkis] Another instance is already running.");
  process.exit(0);
}

const shellEnv = await getShellEnv();

// --- アプリメニュー ---

ApplicationMenu.setApplicationMenu([
  {
    label: "orkis",
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide", accelerator: "CmdOrCtrl+H" },
      { role: "hideOthers", accelerator: "CmdOrCtrl+Alt+H" },
      { role: "showAll" },
      { type: "separator" },
      { role: "quit", accelerator: "CmdOrCtrl+Q" },
    ],
  },
  {
    label: "View",
    submenu: [
      { label: "Toggle DevTools", action: "view-devtools", accelerator: "Alt+CommandOrControl+I" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo", accelerator: "CmdOrCtrl+Z" },
      { role: "redo", accelerator: "CmdOrCtrl+Shift+Z" },
      { type: "separator" },
      { role: "cut", accelerator: "CmdOrCtrl+X" },
      { role: "copy", accelerator: "CmdOrCtrl+C" },
      { role: "paste", accelerator: "CmdOrCtrl+V" },
      { role: "selectAll", accelerator: "CmdOrCtrl+A" },
    ],
  },
]);

// --- メニューアクション ---

ApplicationMenu.on("application-menu-clicked", (event) => {
  const { action } = (event as { data: { action: string } }).data;
  if (action === "view-devtools") {
    const firstWin = windowDirs.keys().next().value;
    if (firstWin) {
      firstWin.webview.toggleDevTools();
    }
  }
});

// --- 起動 ---

const socketServer = setupSocketServer();

const dir = process.env.ORKIS_PROJECT_ROOT ?? homedir();
handleSocketMessage({ type: "open", dir });

// --- クリーンアップ ---

process.on("beforeExit", () => {
  for (const win of windowDirs.keys()) {
    cleanupWindow(win);
  }

  void fileServer.stop();
  socketServer.close();
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }
});
