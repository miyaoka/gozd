import Electrobun from "electrobun/bun";
import { ApplicationMenu, BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { tryCatch } from "@gozd/shared";
import type { GozdRPC, OpenTargetSelection } from "@gozd/rpc";
import {
  parseOwnerRepo,
  resolveOpenTarget,
  filterIgnored,
  getGitCommitFiles,
  getGitLog,
  getGitStatus,
  getPrList,
  getWorktreeList,
  addWorktree,
  removeWorktree,
  attachChangeCounts,
  getBranchList,
  deleteBranch,
} from "./git";
import {
  isAllowedProtocol,
  readFileContent,
  resolveExistingFsPath,
  resolveGitPath,
} from "./security";
import { generateClaudeSettings } from "./claudeHooks";
import { getShellEnv } from "./shellEnv";
import { loadAppState, saveSnapshot, getDefaultFrame } from "./appState";
import { loadConfig, saveConfig } from "./config";
import { loadProjectConfig, saveProjectConfig } from "./projectConfig";
import type { WindowFrame, WindowState } from "./appState";
import {
  loadTodos,
  addTodo,
  updateTodo,
  removeTodo,
  findTodoByWorktreeDir,
  linkTodoToWorktree,
  cleanupStaleTodos,
} from "./todo";

type GozdRPCInstance = ReturnType<typeof BrowserView.defineRPC<GozdRPC>>;
type GozdWindow = BrowserWindow<GozdRPCInstance>;

/** gozd 管理の zsh 初期化ディレクトリ（ZDOTDIR 差し替え用） */
const GOZD_ZDOTDIR = path.resolve(import.meta.dir, "../zsh");
const VITE_DEV_SERVER_URL = "http://localhost:5173";

const channel = await Updater.localInfo.channel();

/** git remote origin URL から owner/repo 形式の名前を取得。失敗時はディレクトリ名にフォールバック */
async function getRepoName(dir: string): Promise<string> {
  const result = await tryCatch(Promise.resolve(Bun.$`git -C ${dir} remote get-url origin`.text()));
  if (result.ok) {
    const ownerRepo = parseOwnerRepo(result.value.trim());
    if (ownerRepo) return ownerRepo;
  }
  return path.basename(dir);
}

/** dev チャンネルかつ Vite dev server が起動していれば HMR 用 URL を返す */
async function getViewUrl(): Promise<string> {
  if (channel === "dev") {
    const result = tryCatch(fetch(VITE_DEV_SERVER_URL, { method: "HEAD" }));
    if ((await result).ok) {
      console.log(`[gozd] HMR enabled: ${VITE_DEV_SERVER_URL}`);
      return VITE_DEV_SERVER_URL;
    }
  }
  return "views://main/index.html";
}

const viewUrl = await getViewUrl();
const SOCKET_PATH = path.join(tmpdir(), `gozd-${channel}.sock`);
const LAUNCH_DIR = path.join(tmpdir(), `gozd-${channel}-launch`);
const LAUNCH_TTL_MS = 30_000;
const GIT_STATUS_DEBOUNCE_MS = 300;
const GIT_WATCH_POLL_MS = 500;

// --- Claude Code hooks 設定 ---

/** Claude Code に --settings で渡す hooks 設定ファイルのパス */
const CLAUDE_SETTINGS_PATH = path.join(tmpdir(), `gozd-${channel}-claude-settings.json`);

/**
 * gozd CLI の実行コマンド。hooks 設定ファイルのコマンド文字列に埋め込まれる。
 * - dev: bun で CLI ソースを直接実行（.app に CLI がバンドルされないため）
 * - build: .app 内のバンドル済み CLI シェルスクリプトを使用
 */
const GOZD_CLI_PATH = (() => {
  if (channel === "dev") {
    const projectRoot = process.env.GOZD_DEV_PROJECT_ROOT;
    if (projectRoot === undefined) throw new Error("GOZD_DEV_PROJECT_ROOT is required in dev mode");
    return path.join(projectRoot, "apps/cli/src/index.ts");
  }
  return path.resolve(import.meta.dir, "../bin/gozd");
})();

/**
 * CLI のランナー。dev 時は bun で TS を直接実行するため必要。
 * build 時は bin/gozd が自前で Bun を解決するため不要（空文字列）。
 */
const GOZD_CLI_RUNNER = channel === "dev" ? "bun" : "";

generateClaudeSettings(CLAUDE_SETTINGS_PATH);

// --- PTY 管理 ---

interface PtyEntry {
  proc: ReturnType<typeof Bun.spawn>;
  win: GozdWindow;
  /** PTY が起動された worktree ディレクトリ */
  worktreeDir: string;
  /** UTF-8 ストリームデコーダ（チャンク分割時のマルチバイト文字化け防止） */
  decoder: TextDecoder;
}

const ptys = new Map<number, PtyEntry>();
let nextPtyId = 0;

function spawnPty(win: GozdWindow, cwd: string, cols: number, rows: number): number {
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
      TERM_PROGRAM: "gozd",
      // CLI ツール（Claude Code 等）に OSC 8 ハイパーリンクの出力を許可する
      FORCE_HYPERLINK: "1",
      LANG: shellEnv.LANG ?? "en_US.UTF-8",
      // Claude Code hooks がどの PTY から発火したか特定するための識別子
      GOZD_PTY_ID: String(id),
      // ZDOTDIR 差し替えで gozd の zsh 初期化を注入する
      GOZD_ORIG_ZDOTDIR: shellEnv.ZDOTDIR ?? homedir(),
      GOZD_ZDOTDIR,
      ZDOTDIR: GOZD_ZDOTDIR,
      // claude() 関数が参照する hooks 設定ファイルパス
      GOZD_CLAUDE_SETTINGS_PATH: CLAUDE_SETTINGS_PATH,
      // CLI が接続するソケットパス（dev/stable でパスが異なる）
      GOZD_SOCKET_PATH: SOCKET_PATH,
      // hooks コマンドが使う CLI の絶対パスとランナー
      GOZD_CLI_PATH,
      GOZD_CLI_RUNNER,
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
      const insideResult = tryCatch(() => resolveGitPath(dir, relPath));
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
      const pathResult = await tryCatch(resolveExistingFsPath(dir, relPath));
      if (!pathResult.ok) return new Response("Forbidden", { status: 403 });
      return new Response(Bun.file(pathResult.value), { headers });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[file-server] listening on http://localhost:${fileServer.port}`);

// --- ウィンドウ管理 ---

/** ウィンドウ → UUID */
const windowIds = new Map<GozdWindow, string>();
const windowDirs = new Map<GozdWindow, string>();
/** プロジェクトディレクトリ → window マッピング（同一プロジェクトのウィンドウ再利用に使用） */
const windowProjectDirs = new Map<GozdWindow, string>();
/** switchDir の世代管理。stale な非同期結果を捨てるために使う */
const windowSwitchGen = new Map<GozdWindow, number>();

/** 個別 close で最後に閉じたウィンドウの状態を退避。before-quit 時に live が空ならこれを保存する */
let lastClosedWindowState: WindowState | null = null;

/** live ウィンドウがないときのフォールバック用フレーム。savedState・close で設定される */
let fallbackFrame: WindowFrame | null = null;

/** 新規ウィンドウに引き継ぐフレームを取得する。live ウィンドウがあればその最新値を優先 */
function getInheritedFrame(): WindowFrame {
  // live ウィンドウの最後のフレームを取得（resize/move 後の最新値）
  const lastWin = [...windowProjectDirs.keys()].at(-1);
  if (lastWin) return lastWin.getFrame();
  // live がなければ最後に閉じたウィンドウのフレーム
  if (fallbackFrame) return fallbackFrame;
  return getDefaultFrame();
}

// git status デバウンス
const gitStatusTimers = new Map<GozdWindow, ReturnType<typeof setTimeout>>();
const gitStatusInFlight = new Set<GozdWindow>();
const gitStatusNeedsRerun = new Set<GozdWindow>();

function scheduleGitStatusUpdate(win: GozdWindow, root: string) {
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
    const result = await tryCatch(getGitStatus(root));
    gitStatusInFlight.delete(win);
    const needsRerun = gitStatusNeedsRerun.has(win);
    if (needsRerun) {
      gitStatusNeedsRerun.delete(win);
      scheduleGitStatusUpdate(win, root);
    }
    if (!result.ok) return;
    // 世代が変わっていたら stale な結果を捨てる
    if ((windowSwitchGen.get(win) ?? 0) !== gen) return;
    // 再実行が予約されている場合、この結果は stale な可能性があるため送信しない
    if (needsRerun) return;
    win.webview.rpc?.send.gitStatusChange(result.value);
  }, GIT_STATUS_DEBOUNCE_MS);

  gitStatusTimers.set(win, timer);
}

// ファイル監視
const windowFsWatchers = new Map<GozdWindow, fs.FSWatcher>();
const windowGitWatchedFiles = new Map<GozdWindow, string[]>();

/** linked worktree 対応: `.git` がファイル（gitdir: ...）の場合に実際の git ディレクトリを解決 */
async function resolveGitDir(root: string): Promise<string> {
  const result = await tryCatch(
    new Response(Bun.spawn(["git", "rev-parse", "--git-dir"], { cwd: root }).stdout).text(),
  );
  if (!result.ok) return path.join(root, ".git");
  const gitDir = result.value.trim();
  return path.isAbsolute(gitDir) ? gitDir : path.resolve(root, gitDir);
}

function startWatching(win: GozdWindow, root: string) {
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
  });

  windowFsWatchers.set(win, watcher);

  // .git 関連ファイルの監視（linked worktree では .git がファイルなので git rev-parse で解決）
  void (async () => {
    const gitDir = await resolveGitDir(root);
    const indexPath = path.join(gitDir, "index");
    const headPath = path.join(gitDir, "HEAD");

    /** git rev-parse --git-path で ref 名を実ファイルパスに解決する */
    async function resolveRefPath(refName: string): Promise<string | undefined> {
      const result = await tryCatch(
        new Response(
          Bun.spawn(["git", "rev-parse", "--git-path", refName], { cwd: root }).stdout,
        ).text(),
      );
      if (!result.ok) return undefined;
      const resolved = result.value.trim();
      return path.isAbsolute(resolved) ? resolved : path.resolve(root, resolved);
    }

    /** HEAD が指す ref の実ファイルパスを解決する。worktree では refs は commondir にあるため git に解決させる */
    async function resolveCurrentRefPath(): Promise<string | undefined> {
      try {
        const headContent = fs.readFileSync(headPath, "utf-8").trim();
        if (!headContent.startsWith("ref: ")) return undefined;
        const refName = headContent.slice(5);
        return await resolveRefPath(refName);
      } catch {
        // detached HEAD 等
      }
      return undefined;
    }

    /**
     * 現在のブランチに対応するリモート追跡 ref のパスを解決する。
     * refs/heads/foo → refs/remotes/origin/foo
     */
    async function resolveRemoteRefPath(): Promise<string | undefined> {
      try {
        const headContent = fs.readFileSync(headPath, "utf-8").trim();
        if (!headContent.startsWith("ref: ")) return undefined;
        const refName = headContent.slice(5);
        // refs/heads/foo → refs/remotes/origin/foo
        if (!refName.startsWith("refs/heads/")) return undefined;
        const branchName = refName.slice("refs/heads/".length);
        return await resolveRefPath(`refs/remotes/origin/${branchName}`);
      } catch {
        return undefined;
      }
    }

    let currentRefPath = await resolveCurrentRefPath();
    let remoteRefPath = await resolveRemoteRefPath();

    function syncGitWatchedFiles() {
      const files = [indexPath, headPath];
      if (currentRefPath) files.push(currentRefPath);
      if (remoteRefPath) files.push(remoteRefPath);
      windowGitWatchedFiles.set(win, files);
    }

    /** updateRefWatch の直列化用。並行呼び出しで古い完了が新しい ref を上書きするのを防ぐ */
    let refWatchGen = 0;

    async function updateRefWatch() {
      const gen = ++refWatchGen;
      const [newRefPath, newRemoteRefPath] = await Promise.all([
        resolveCurrentRefPath(),
        resolveRemoteRefPath(),
      ]);
      // 非同期中に別の呼び出しが走っていたらこの結果は stale
      if (gen !== refWatchGen) return;

      // ローカル ref の更新
      if (newRefPath !== currentRefPath) {
        if (currentRefPath) fs.unwatchFile(currentRefPath);
        currentRefPath = newRefPath;
        if (currentRefPath) {
          fs.watchFile(currentRefPath, { interval: GIT_WATCH_POLL_MS }, () => {
            scheduleGitStatusUpdate(win, root);
          });
        }
      }

      // リモート追跡 ref の更新
      if (newRemoteRefPath !== remoteRefPath) {
        if (remoteRefPath) fs.unwatchFile(remoteRefPath);
        remoteRefPath = newRemoteRefPath;
        if (remoteRefPath) {
          fs.watchFile(remoteRefPath, { interval: GIT_WATCH_POLL_MS }, () => {
            scheduleGitStatusUpdate(win, root);
          });
        }
      }

      syncGitWatchedFiles();
    }

    fs.watchFile(indexPath, { interval: GIT_WATCH_POLL_MS }, () => {
      scheduleGitStatusUpdate(win, root);
    });

    fs.watchFile(headPath, { interval: GIT_WATCH_POLL_MS }, async () => {
      await updateRefWatch();
      scheduleGitStatusUpdate(win, root);
    });

    if (currentRefPath) {
      fs.watchFile(currentRefPath, { interval: GIT_WATCH_POLL_MS }, () => {
        scheduleGitStatusUpdate(win, root);
      });
    }
    if (remoteRefPath) {
      fs.watchFile(remoteRefPath, { interval: GIT_WATCH_POLL_MS }, () => {
        scheduleGitStatusUpdate(win, root);
      });
    }
    syncGitWatchedFiles();
  })();
}

function stopWatching(win: GozdWindow) {
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
const windowWorktreeWatchers = new Map<GozdWindow, Map<string, WorktreeWatchEntry>>();
const wtChangeTimers = new Map<GozdWindow, ReturnType<typeof setTimeout>>();
/** syncWorktreeWatchers の世代管理（並行実行で stale な結果を破棄するため） */
const wtSyncGen = new Map<GozdWindow, number>();

/** 非アクティブ worktree でファイル変更があったことをデバウンスして通知 */
function scheduleWorktreeChangeNotify(win: GozdWindow) {
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
async function syncWorktreeWatchers(win: GozdWindow, projectDir: string, activeDir: string) {
  const gen = (wtSyncGen.get(win) ?? 0) + 1;
  wtSyncGen.set(win, gen);

  const entries = await getWorktreeList(projectDir);

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

function stopWorktreeWatchers(win: GozdWindow) {
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
function cleanupWindow(win: GozdWindow) {
  stopWatching(win);
  stopWorktreeWatchers(win);
  const windowId = windowIds.get(win);
  if (windowId) fileServerDirs.delete(windowId);
  windowIds.delete(win);
  windowDirs.delete(win);
  windowProjectDirs.delete(win);
  windowSwitchGen.delete(win);
  // このウィンドウが所有する PTY をすべて kill
  for (const [id, entry] of ptys) {
    if (entry.win === win) {
      entry.proc.kill();
      ptys.delete(id);
    }
  }
}

// --- ウィンドウ作成 ---

interface CreateWindowOptions {
  initialSelection?: OpenTargetSelection;
  savedFrame?: WindowFrame;
  /** 起動時に切り替える worktree ディレクトリ（dir と異なる場合） */
  initialActiveDir?: string;
}

function createWindowWithRPC(dir: string, options?: CreateWindowOptions): GozdWindow {
  let win: GozdWindow;
  const { initialSelection, savedFrame, initialActiveDir } = options ?? {};

  /** worktree/branch 管理用（固定） */
  const projectDir = dir;
  /** ファイル操作用（switchDir で切り替え可能） */
  let currentDir = initialActiveDir ?? dir;
  const initialFrame = savedFrame ?? getDefaultFrame();

  async function updateWindowTitle(): Promise<void> {
    const repoName = await getRepoName(projectDir);
    win.setTitle(`gozd - ${repoName}`);
  }

  const rpc: GozdRPCInstance = BrowserView.defineRPC<GozdRPC>({
    handlers: {
      requests: {
        ptySpawn: async ({ dir, cols, rows }) => {
          // renderer から受け取った dir を cwd として使用（currentDir への暗黙依存を排除）
          const realCwd = await fsp.realpath(dir);
          return spawnPty(win, realCwd, cols, rows);
        },
        fsReadDir: async ({ relPath }) => {
          const absolutePath = await resolveExistingFsPath(currentDir, relPath);
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
          const absolutePath = await resolveExistingFsPath(currentDir, relPath);
          return readFileContent(absolutePath);
        },
        fsReadFileAbsolute: async ({ absolutePath }) => {
          return readFileContent(absolutePath);
        },
        gitShowFile: async ({ relPath }) => {
          resolveGitPath(currentDir, relPath);
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
          resolveGitPath(currentDir, relPath);
          const result = await tryCatch(
            new Response(
              Bun.spawn(["git", "diff", "HEAD", "--", relPath], { cwd: currentDir }).stdout,
            ).text(),
          );
          if (!result.ok) return "";
          return result.value;
        },
        gitStatus: async () => (await getGitStatus(currentDir)).statuses,
        gitCommitFiles: ({ hash, compareHash }) => getGitCommitFiles(currentDir, hash, compareHash),
        gitLog: ({ maxCount, firstParentOnly }) =>
          getGitLog({ cwd: currentDir, maxCount, firstParentOnly }),
        gitPrList: () => getPrList({ cwd: projectDir, env: shellEnv }),
        gitWorktreeList: async () => {
          const entries = await attachChangeCounts(await getWorktreeList(projectDir));
          // 各 worktree に紐づく Todo を付与
          const todos = loadTodos(projectDir);
          const todoByDir = new Map(
            todos.filter((t) => t.worktreeDir).map((t) => [t.worktreeDir, t]),
          );
          for (const entry of entries) {
            const todo = todoByDir.get(entry.path);
            if (todo) entry.todo = todo;
          }
          return entries;
        },
        gitBranchList: () => getBranchList(projectDir),
        createWorktree: async ({ worktreeDir, branch }) => {
          const { worktreeSymlinks } = loadProjectConfig(projectDir);
          const entry = await addWorktree({
            cwd: projectDir,
            worktreeDir,
            branch,
            symlinks: worktreeSymlinks,
          });

          // switchDir 相当: 作成したパスは自明に正当なので検証不要
          const gen = (windowSwitchGen.get(win) ?? 0) + 1;
          windowSwitchGen.set(win, gen);
          currentDir = entry.path;
          stopWatching(win);
          startWatching(win, currentDir);
          const windowId = windowIds.get(win) ?? "";
          windowDirs.set(win, currentDir);
          fileServerDirs.set(windowId, currentDir);
          scheduleGitStatusUpdate(win, currentDir);
          void syncWorktreeWatchers(win, projectDir, currentDir);

          return {
            worktree: entry,
            dir: currentDir,
            fileServerBaseUrl: `http://localhost:${fileServer.port}/${windowId}`,
          };
        },
        gitWorktreeRemove: async ({ path: wtPath, force }) => {
          const wtReal = await fsp.realpath(wtPath);
          await removeWorktree(projectDir, wtPath, force);
          // 紐づく Todo も削除
          const todo = findTodoByWorktreeDir(projectDir, wtPath);
          if (todo) removeTodo(projectDir, todo.id);
          // 削除成功後に worktree の PTY を kill する
          for (const [id, entry] of ptys) {
            if (entry.win === win && entry.worktreeDir === wtReal) {
              entry.proc.kill();
              ptys.delete(id);
            }
          }
          void syncWorktreeWatchers(win, projectDir, currentDir);
        },
        gitBranchDelete: ({ branch }) => deleteBranch(projectDir, branch),
        todoList: () => loadTodos(projectDir),
        todoAdd: ({ body, icon, worktreeDir }) => addTodo(projectDir, body, icon, worktreeDir),
        todoUpdate: ({ id, body, icon }) => updateTodo(projectDir, id, body, icon),
        todoRemove: ({ id }) => removeTodo(projectDir, id),
        createWorktreeWithTodo: async ({ id, worktreeDir, branch }) => {
          const { worktreeSymlinks } = loadProjectConfig(projectDir);
          const entry = await addWorktree({
            cwd: projectDir,
            worktreeDir,
            branch,
            symlinks: worktreeSymlinks,
          });
          linkTodoToWorktree(projectDir, id, entry.path);
          const todo = loadTodos(projectDir).find((t) => t.id === id);
          if (!todo) throw new Error(`Todo not found after linking: ${id}`);
          entry.todo = todo;

          // switchDir 相当: 作成したパスは自明に正当なので検証不要
          const gen = (windowSwitchGen.get(win) ?? 0) + 1;
          windowSwitchGen.set(win, gen);
          currentDir = entry.path;
          stopWatching(win);
          startWatching(win, currentDir);
          const windowId = windowIds.get(win) ?? "";
          windowDirs.set(win, currentDir);
          fileServerDirs.set(windowId, currentDir);
          scheduleGitStatusUpdate(win, currentDir);
          void syncWorktreeWatchers(win, projectDir, currentDir);

          return {
            todo,
            worktree: entry,
            dir: currentDir,
            fileServerBaseUrl: `http://localhost:${fileServer.port}/${windowId}`,
          };
        },
        configLoad: () => loadConfig(),
        configSave: (config) => saveConfig(config),
        projectConfigLoad: () => loadProjectConfig(projectDir),
        projectConfigSave: (config) => saveProjectConfig(projectDir, config),
        voicevoxLaunch: async () => {
          // mdfind で VOICEVOX.app を検索（/Applications, ~/Applications, カスタム場所に対応）
          const mdfind = Bun.spawn(
            ["mdfind", "kMDItemCFBundleIdentifier == 'jp.hiroshiba.voicevox'"],
            { stdout: "pipe", stderr: "pipe" },
          );
          const output = await new Response(mdfind.stdout).text();
          const mdfindStderr = await new Response(mdfind.stderr).text();
          const mdfindExitCode = await mdfind.exited;
          if (mdfindExitCode !== 0) {
            console.error(`[voicevox] mdfind failed (exit ${mdfindExitCode}): ${mdfindStderr}`);
            return false;
          }
          const [appPath] = output.trim().split("\n");
          if (!appPath) {
            console.error("[voicevox] mdfind returned no results");
            return false;
          }
          const enginePath = path.join(appPath, "Contents/Resources/vv-engine/run");
          if (!fs.existsSync(enginePath)) {
            console.error(`[voicevox] engine not found: ${enginePath}`);
            return false;
          }
          // Engine だけをバックグラウンドで起動（GUI なし）
          // stderr: "inherit" でパイプ詰まりを防ぎ、Electrobun コンソールに出力
          const engine = Bun.spawn([enginePath], {
            stdout: "ignore",
            stderr: "inherit",
          });
          // 即座に終了していないか短時間だけ確認する
          const earlyExit = await Promise.race([
            engine.exited.then((code) => code),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
          ]);
          if (earlyExit !== null) {
            console.error(`[voicevox] engine exited immediately (code ${earlyExit})`);
            return false;
          }
          return true;
        },
        voicevoxCheckEngine: async () => {
          const result = await tryCatch(fetch("http://127.0.0.1:50021/version"));
          return result.ok && result.value.ok;
        },
        voicevoxSpeak: async ({ text, speedScale, volumeScale, speakerId }) => {
          const VOICEVOX_API = "http://127.0.0.1:50021";
          const queryRes = await fetch(
            `${VOICEVOX_API}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
            { method: "POST" },
          );
          if (!queryRes.ok) return undefined;
          const query = await queryRes.json();
          query.speedScale = speedScale;
          query.volumeScale = volumeScale;
          const audioRes = await fetch(`${VOICEVOX_API}/synthesis?speaker=${speakerId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(query),
          });
          if (!audioRes.ok) return undefined;
          const buf = await audioRes.arrayBuffer();
          return Buffer.from(buf).toString("base64");
        },
        switchDir: async ({ dir: targetDir }) => {
          // バリデーション: worktree list に含まれるパスのみ許可
          const worktrees = await getWorktreeList(projectDir);
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
          void syncWorktreeWatchers(win, projectDir, currentDir);

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
        windowClose: () => {
          win.close();
        },
        rendererReady: async () => {
          console.log("[gozd] rendererReady received, sending gozdOpen:", currentDir);
          const windowId = windowIds.get(win) ?? "";
          const repoName = await getRepoName(projectDir);
          win.webview.rpc?.send.gozdOpen({
            dir: currentDir,
            selection: initialSelection,
            fileServerBaseUrl: `http://localhost:${fileServer.port}/${windowId}`,
            channel,
            repoName,
          });

          // 起動時に消失した worktree の Todo をクリーンアップ
          void (async () => {
            const wtList = await getWorktreeList(projectDir);
            cleanupStaleTodos(
              projectDir,
              wtList.map((wt) => wt.path),
            );
          })();

          // 非アクティブ worktree の監視を開始
          void syncWorktreeWatchers(win, projectDir, currentDir);
        },
      },
    },
  });

  win = new BrowserWindow({
    title: "gozd",
    url: viewUrl,
    frame: initialFrame,
    titleBarStyle: "hiddenInset",
    rpc,
  });

  void updateWindowTitle();

  win.on("close", () => {
    // 閉じる直前の状態を退避（before-quit で live が空なら復元に使う）
    const frame = win.getFrame();
    lastClosedWindowState = { dir: projectDir, activeDir: currentDir, frame };
    fallbackFrame = frame;
    cleanupWindow(win);
  });

  return win;
}

// --- ソケット通信 ---

interface HookMessage {
  type: "hook";
  event: string;
  payload: Record<string, unknown>;
}

interface OpenMessage {
  type: "open";
  /** CLI から受け取った絶対パス（パス解決は desktop 側で行う） */
  targetPath: string;
}

type GozdMessage = HookMessage | OpenMessage;

function findWindowByDir(dir: string): GozdWindow | undefined {
  for (const [win, projDir] of windowProjectDirs) {
    if (projDir === dir) return win;
  }
  return undefined;
}

interface LaunchRequestResult {
  requests: { targetPath: string }[];
  errors: string[];
}

/** launch request ファイルを同期的に読み取り、処理済みにする */
function readLaunchRequests(): LaunchRequestResult {
  const requests: { targetPath: string }[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(LAUNCH_DIR)) return { requests, errors };
  const entries = tryCatch(() => fs.readdirSync(LAUNCH_DIR));
  if (!entries.ok) {
    errors.push(`ディレクトリ読み取り失敗: ${LAUNCH_DIR} (${entries.error.message})`);
    return { requests, errors };
  }
  const now = Date.now();
  for (const name of entries.value) {
    const filePath = `${LAUNCH_DIR}/${name}`;
    // stale ファイル（.claimed 含む）を TTL で掃除
    const stat = tryCatch(() => fs.statSync(filePath));
    if (!stat.ok) continue;
    if (now - stat.value.mtimeMs > LAUNCH_TTL_MS) {
      tryCatch(() => fs.unlinkSync(filePath));
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const content = tryCatch(() => fs.readFileSync(filePath, "utf-8"));
    if (!content.ok) {
      errors.push(`${name}: ${content.error.message}`);
      continue;
    }
    const parsed = tryCatch(() => JSON.parse(content.value) as unknown);
    if (!parsed.ok) {
      errors.push(`${name}: ${parsed.error.message}`);
      continue;
    }
    const obj = parsed.value;
    if (
      typeof obj !== "object" ||
      obj === null ||
      typeof (obj as Record<string, unknown>).targetPath !== "string"
    ) {
      errors.push(`${name}: 不正なペイロード`);
      continue;
    }
    const req = obj as { targetPath: string };
    // 処理済みにする
    tryCatch(() => fs.renameSync(filePath, `${filePath}.claimed`));
    requests.push(req);
  }
  return { requests, errors };
}

interface OpenWindowRequest {
  projectDir: string;
  activeDir: string;
  selection?: OpenTargetSelection;
  savedFrame?: WindowFrame;
}

/** ウィンドウを開くまたは既存ウィンドウを再利用する */
function openWindow(req: OpenWindowRequest): void {
  const { projectDir, activeDir, selection, savedFrame } = req;
  console.log(
    `[gozd] open: project=${projectDir}, active=${activeDir}, selection=${selection ? `${selection.kind}:${selection.relPath}` : "(none)"}`,
  );
  const existing = findWindowByDir(projectDir);
  if (existing) {
    existing.focus();
    const existingId = windowIds.get(existing) ?? "";
    const currentDir = windowDirs.get(existing) ?? projectDir;
    // 表示中の worktree と異なる場合は switchToDir で切り替えを指示
    const switchToDir = activeDir !== currentDir ? activeDir : undefined;
    void getRepoName(projectDir).then((repoName) => {
      existing.webview.rpc?.send.gozdOpen({
        dir: currentDir,
        selection,
        fileServerBaseUrl: `http://localhost:${fileServer.port}/${existingId}`,
        channel,
        repoName,
        switchToDir,
      });
    });
    return;
  }
  const frame = savedFrame ?? getInheritedFrame();
  const newWin = createWindowWithRPC(projectDir, {
    initialSelection: selection,
    savedFrame: frame,
    initialActiveDir: activeDir,
  });
  const windowId = crypto.randomUUID();
  windowIds.set(newWin, windowId);
  fileServerDirs.set(windowId, activeDir);
  windowDirs.set(newWin, activeDir);
  windowProjectDirs.set(newWin, projectDir);
  windowSwitchGen.set(newWin, 0);
  startWatching(newWin, activeDir);
}

function handleSocketMessage(message: GozdMessage) {
  switch (message.type) {
    case "hook": {
      console.log(`[gozd] hook: ${message.event}`, message.payload);
      const hookPayload = { event: message.event, payload: message.payload };

      // payload.ptyId から該当ウィンドウを特定して送信
      const ptyId = typeof message.payload.ptyId === "number" ? message.payload.ptyId : undefined;
      if (ptyId !== undefined) {
        const entry = ptys.get(ptyId);
        if (entry) {
          entry.win.webview.rpc?.send.gozdHook(hookPayload);
          break;
        }
      }

      // ptyId がない、または該当 PTY が見つからない場合は全ウィンドウにブロードキャスト
      for (const win of windowDirs.keys()) {
        win.webview.rpc?.send.gozdHook(hookPayload);
      }
      break;
    }
    case "open": {
      openWindow(resolveOpenTarget(message.targetPath));
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
        const result = tryCatch(() => JSON.parse(line) as GozdMessage);
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
  console.log("[gozd] Another instance is already running.");
  process.exit(0);
}

const shellEnv = await getShellEnv();

// --- アプリメニュー ---

ApplicationMenu.setApplicationMenu([
  {
    label: "gozd",
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
const savedState = loadAppState();

// 前回セッションの最後のフレームを引き継ぎ用に設定
const lastSavedWindow = savedState.windows.at(-1);
if (lastSavedWindow) {
  fallbackFrame = lastSavedWindow.frame;
}

// macOS の ApplicationMenu が正しく動作するには、初回ウィンドウを同期的に作成する必要がある
// （role メニューは active app + key window + responder chain に依存するため）
const initialDir = process.env.GOZD_DEV_PROJECT_ROOT;
if (initialDir) {
  // pnpm dev: worktree 内で実行しても main worktree のルートに解決する
  openWindow(resolveOpenTarget(initialDir));
} else {
  // CLI cold start: launch request ファイルから dir を読む
  // Dock/Finder: request がなければ前回の状態を復元
  const { requests, errors } = readLaunchRequests();
  if (requests.length > 0) {
    for (const req of requests) {
      openWindow(resolveOpenTarget(req.targetPath));
    }
  } else if (savedState.windows.length > 0) {
    // 前回の状態を復元（プロジェクト・ウィンドウサイズ・位置）
    let restored = false;
    for (const ws of savedState.windows) {
      if (!fs.existsSync(ws.dir)) continue;
      // activeDir が存在しなければ dir（project root）にフォールバック
      const activeDir = fs.existsSync(ws.activeDir) ? ws.activeDir : ws.dir;
      openWindow({ projectDir: ws.dir, activeDir, savedFrame: ws.frame });
      restored = true;
    }
    if (!restored) {
      openWindow({ projectDir: homedir(), activeDir: homedir() });
    }
  } else {
    openWindow({ projectDir: homedir(), activeDir: homedir() });
  }
  if (errors.length > 0) {
    void Utils.showMessageBox({
      type: "error",
      title: "gozd",
      message: "launch request の読み取りに失敗しました",
      detail: errors.join("\n"),
      buttons: ["OK"],
    });
  }
}

// --- アプリ終了時の状態保存 ---
// before-quit が永続化の唯一のコミット点。close では live 状態のみ更新する。

Electrobun.events.on("before-quit", () => {
  // live ウィンドウから snapshot を構築
  const snapshot: WindowState[] = [];
  for (const [win, projDir] of windowProjectDirs) {
    const activeDir = windowDirs.get(win) ?? projDir;
    const frame = win.getFrame();
    snapshot.push({ dir: projDir, activeDir, frame });
  }
  // live が空（最後の1枚を個別 close した直後）なら退避した状態を使う
  if (snapshot.length === 0 && lastClosedWindowState) {
    snapshot.push(lastClosedWindowState);
  }
  saveSnapshot(snapshot);
});

// --- クリーンアップ ---
// forceExit(0) で到達しない可能性があるが、安全策として残す

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
