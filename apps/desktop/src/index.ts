import { ApplicationMenu, BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { tryCatch } from "@orkis/shared";
import type { OrkisRPC } from "@orkis/rpc";

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

// --- ウィンドウ管理 ---

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
  windowDirs.delete(win);
  // このウィンドウが所有する PTY をすべて kill
  for (const [id, entry] of ptys) {
    if (entry.win === win) {
      entry.proc.kill();
      ptys.delete(id);
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

          return visibleEntries.map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            isIgnored: ignored.has(entry.name),
          }));
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
          win.webview.rpc?.send.orkisOpen({ dir });
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
        existing.webview.rpc?.send.orkisOpen({ dir: message.dir, file: message.file });
        break;
      }
      const newWin = createWindowWithRPC(message.dir);
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

// --- 起動 ---

const socketServer = setupSocketServer();

const dir = process.env.ORKIS_PROJECT_ROOT ?? process.cwd();
handleSocketMessage({ type: "open", dir });

// --- クリーンアップ ---

process.on("beforeExit", () => {
  for (const win of windowDirs.keys()) {
    cleanupWindow(win);
  }

  socketServer.close();
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }
});
