import { ApplicationMenu, BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { tryCatch } from "@orkis/shared";
import type { LspDiagnostic, OrkisRPC } from "@orkis/rpc";
import { createLspClient } from "./lsp";
import type { LspClient } from "./lsp";

type OrkisRPCInstance = ReturnType<typeof BrowserView.defineRPC<OrkisRPC>>;
type OrkisWindow = BrowserWindow<OrkisRPCInstance>;

const SOCKET_PATH = "/tmp/orkis.sock";
const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);
const VITE_DEV_SERVER_URL = "http://localhost:5173";

/** dev チャンネルかつ Vite dev server が起動していれば HMR 用 URL を返す */
async function getViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
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
const GIT_STATUS_DEBOUNCE_MS = 300;
const GIT_WATCH_POLL_MS = 500;

// --- PTY 管理 ---

interface PtyEntry {
  proc: ReturnType<typeof Bun.spawn>;
  win: OrkisWindow;
}

const ptys = new Map<number, PtyEntry>();
let nextPtyId = 0;

function spawnPty(win: OrkisWindow, cwd: string, cols: number, rows: number): number {
  const id = nextPtyId++;
  const shell = process.env.SHELL ?? "zsh";

  const proc = Bun.spawn([shell], {
    cwd,
    env: process.env as Record<string, string>,
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        const text = new TextDecoder().decode(data);
        win.webview.rpc?.send.ptyData({ id, data: text });
      },
      exit() {
        ptys.delete(id);
        win.webview.rpc?.send.ptyExit({ id, exitCode: proc.exitCode ?? 1 });
      },
    },
  });

  ptys.set(id, { proc, win });
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

// git status デバウンス
const gitStatusTimers = new Map<OrkisWindow, ReturnType<typeof setTimeout>>();
const gitStatusInFlight = new Set<OrkisWindow>();
const gitStatusNeedsRerun = new Set<OrkisWindow>();

function scheduleGitStatusUpdate(win: OrkisWindow, root: string) {
  const existing = gitStatusTimers.get(win);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    gitStatusTimers.delete(win);

    if (gitStatusInFlight.has(win)) {
      gitStatusNeedsRerun.add(win);
      return;
    }

    gitStatusInFlight.add(win);
    try {
      const statuses = await getGitStatus(root);
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
        void (async () => {
          const absPath = path.join(root, filename);
          const fileResult = await tryCatch(fsp.readFile(absPath, "utf-8"));
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

  // .git 関連ファイルの監視
  const gitDir = path.join(root, ".git");
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

/** ウィンドウ close 時に関連リソースをすべて解放する */
function cleanupWindow(win: OrkisWindow) {
  stopWatching(win);
  const windowId = windowIds.get(win);
  if (windowId) fileServerDirs.delete(windowId);
  windowIds.delete(win);
  windowDirs.delete(win);
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

  const rpc: OrkisRPCInstance = BrowserView.defineRPC<OrkisRPC>({
    handlers: {
      requests: {
        ptySpawn: ({ cols, rows }) => spawnPty(win, dir, cols, rows),
        fsReadDir: async ({ relPath }) => {
          const absolutePath = await resolveSecurePath(dir, relPath);
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
          const absolutePath = await resolveSecurePath(dir, relPath);
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
          assertInsideRoot(dir, relPath);
          const proc = Bun.spawn(["git", "show", `HEAD:${relPath}`], { cwd: dir });
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
          assertInsideRoot(dir, relPath);
          const result = await tryCatch(
            new Response(
              Bun.spawn(["git", "diff", "HEAD", "--", relPath], { cwd: dir }).stdout,
            ).text(),
          );
          if (!result.ok) return "";
          return result.value;
        },
        gitStatus: () => getGitStatus(dir),
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
          console.log("[orkis] rendererReady received, sending orkisOpen:", dir);
          const windowId = windowIds.get(win) ?? "";
          win.webview.rpc?.send.orkisOpen({
            dir,
            fileServerBaseUrl: `http://localhost:${fileServer.port}/${windowId}`,
          });

          // webview 準備完了後に LSP を起動
          void (async () => {
            const clients: LspClient[] = [];
            const diagCallback = (
              source: string,
              relPath: string,
              diagnostics: LspDiagnostic[],
            ) => {
              if (diagnostics.length > 0) {
                console.log(`[diag:${source}] ${relPath}: ${diagnostics.length} items`);
              }
              win.webview.rpc?.send.lspDiagnostics({ relPath, diagnostics });
            };

            // tsgo（TS/JS 用）
            const tsgoPath = await resolveTsgoPath(dir);
            if (tsgoPath) {
              clients.push(
                createLspClient({
                  rootDir: dir,
                  server: { kind: "tsgo", binaryPath: tsgoPath },
                  onDiagnostics: (relPath, diags) => diagCallback("tsgo", relPath, diags),
                  onError: (msg) => console.error(`[lsp:tsgo] ${msg}`),
                }),
              );
            }

            // Vue Language Server（Vue SFC 用、apps/renderer をルートにする）
            const rendererDir = path.join(dir, "apps", "renderer");
            console.log(`[lsp:vue] rendererDir: ${rendererDir}`);
            const vuePaths = resolveVueLspPaths(dir, rendererDir);
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
  for (const [win, windowDir] of windowDirs) {
    if (windowDir === dir) return win;
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
        });
        break;
      }
      const newWin = createWindowWithRPC(message.dir);
      const windowId = crypto.randomUUID();
      windowIds.set(newWin, windowId);
      fileServerDirs.set(windowId, message.dir);
      windowDirs.set(newWin, message.dir);
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

const dir = process.env.ORKIS_PROJECT_ROOT ?? process.cwd();
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
