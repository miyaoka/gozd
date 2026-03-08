import { app, shell, BrowserWindow, ipcMain } from "electron";
import { execFile } from "node:child_process";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type net from "node:net";

const execFileAsync = promisify(execFile);
import watcher from "@parcel/watcher";
import type { AsyncSubscription } from "@parcel/watcher";
import * as pty from "node-pty";
import { cleanupSocket, setupSocketServer, type OrkisMessage } from "./socket-server";

const ptys = new Map<number, pty.IPty>();
let nextPtyId = 0;

function setupPtyHandlers() {
  ipcMain.handle("pty:spawn", (event, cols: number, rows: number) => {
    const id = nextPtyId++;
    const shell = process.env.SHELL ?? "zsh";
    const win = BrowserWindow.fromWebContents(event.sender);
    const cwd = (win ? windowDirs.get(win.id) : undefined) ?? process.env.HOME;
    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: process.env as Record<string, string>,
    });

    ptys.set(id, ptyProcess);

    ptyProcess.onData((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("pty:data", id, data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      ptys.delete(id);
      if (!event.sender.isDestroyed()) {
        event.sender.send("pty:exit", id, exitCode);
      }
    });

    return id;
  });

  ipcMain.on("pty:write", (_event, id: number, data: string) => {
    ptys.get(id)?.write(data);
  });

  ipcMain.on("pty:resize", (_event, id: number, cols: number, rows: number) => {
    ptys.get(id)?.resize(cols, rows);
  });

  ipcMain.on("pty:kill", (_event, id: number) => {
    ptys.get(id)?.kill();
    ptys.delete(id);
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: fileURLToPath(import.meta.resolve("@orkis/preload")),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.resolve(import.meta.dirname, "../../renderer/dist/index.html"));
  }

  return mainWindow;
}

let socketServer: net.Server | undefined;

// ウィンドウが開いているディレクトリを管理
const windowDirs = new Map<number, string>();
// ウィンドウごとのファイル監視サブスクリプション
const windowWatchers = new Map<number, AsyncSubscription>();
// ウィンドウごとの .git 関連ファイル監視（git 操作の検知用）
const gitWatchedFiles = new Map<number, string[]>();

/**
 * 指定ウィンドウのワークスペースディレクトリをファイル監視する。
 * 変更があったらレンダラーに変更されたディレクトリの相対パスを通知する。
 */
async function startWatching(windowId: number, root: string) {
  const win = BrowserWindow.fromId(windowId);
  if (!win) return;

  const subscription = await watcher.subscribe(
    root,
    (err, events) => {
      if (err) {
        console.error("[orkis] watcher error:", err);
        return;
      }
      if (win.isDestroyed()) return;

      // 変更のあったディレクトリパスを重複排除して通知
      const changedDirs = new Set<string>();
      for (const event of events) {
        const rel = path.relative(root, path.dirname(event.path));
        changedDirs.add(rel);
      }
      for (const relDir of changedDirs) {
        win.webContents.send("fs:change", relDir);
      }
      scheduleGitStatusUpdate(windowId, root);
    },
    { ignore: [".git", "**/node_modules"] },
  );

  windowWatchers.set(windowId, subscription);

  // .git 関連ファイルを監視して git 操作（add, commit, checkout, stash 等）を検知
  // .git/index: add/stage で更新
  // .git/HEAD: checkout で更新
  // .git/refs/heads/<branch>: commit/merge/rebase で更新
  const gitDir = path.join(root, ".git");
  const indexPath = path.join(gitDir, "index");
  const headPath = path.join(gitDir, "HEAD");
  const GIT_WATCH_POLL_MS = 500;

  // HEAD から現在のブランチの ref ファイルパスを解決する
  function resolveCurrentRefPath(): string | undefined {
    try {
      const headContent = nodeFs.readFileSync(headPath, "utf-8").trim();
      if (headContent.startsWith("ref: ")) {
        return path.join(gitDir, headContent.slice(5));
      }
    } catch {
      // HEAD が読めない場合（detached HEAD 等）は undefined
    }
    return undefined;
  }

  // 現在監視中のブランチ ref パス
  let currentRefPath = resolveCurrentRefPath();

  // gitWatchedFiles を現在の監視状態に合わせて更新
  function syncGitWatchedFiles() {
    const files = [indexPath, headPath];
    if (currentRefPath) files.push(currentRefPath);
    gitWatchedFiles.set(windowId, files);
  }

  // HEAD 変更時にブランチ ref の監視先を張り替える
  function updateRefWatch() {
    const newRefPath = resolveCurrentRefPath();
    if (newRefPath === currentRefPath) return;

    if (currentRefPath) {
      nodeFs.unwatchFile(currentRefPath);
    }
    currentRefPath = newRefPath;
    if (currentRefPath) {
      nodeFs.watchFile(currentRefPath, { interval: GIT_WATCH_POLL_MS }, () => {
        scheduleGitStatusUpdate(windowId, root);
      });
    }
    syncGitWatchedFiles();
  }

  // index 監視
  nodeFs.watchFile(indexPath, { interval: GIT_WATCH_POLL_MS }, () => {
    scheduleGitStatusUpdate(windowId, root);
  });

  // HEAD 監視（変更時にブランチ ref の監視先も更新）
  nodeFs.watchFile(headPath, { interval: GIT_WATCH_POLL_MS }, () => {
    updateRefWatch();
    scheduleGitStatusUpdate(windowId, root);
  });

  // 初期ブランチ ref 監視
  if (currentRefPath) {
    nodeFs.watchFile(currentRefPath, { interval: GIT_WATCH_POLL_MS }, () => {
      scheduleGitStatusUpdate(windowId, root);
    });
  }
  syncGitWatchedFiles();
}

async function stopWatching(windowId: number) {
  const subscription = windowWatchers.get(windowId);
  if (subscription) {
    await subscription.unsubscribe();
    windowWatchers.delete(windowId);
  }
  const watchedFiles = gitWatchedFiles.get(windowId);
  if (watchedFiles) {
    for (const filePath of watchedFiles) {
      nodeFs.unwatchFile(filePath);
    }
    gitWatchedFiles.delete(windowId);
  }
  // デバウンスタイマーと実行状態をクリーンアップ
  const timer = gitStatusTimers.get(windowId);
  if (timer) {
    clearTimeout(timer);
    gitStatusTimers.delete(windowId);
  }
  gitStatusInFlight.delete(windowId);
  gitStatusNeedsRerun.delete(windowId);
}

/**
 * IPC の送信元ウィンドウに紐づくルートディレクトリを取得する。
 * renderer からは相対パスを受け取り、ここで絶対パスに解決する。
 */
function resolveWindowRoot(event: Electron.IpcMainInvokeEvent): string | undefined {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return undefined;
  return windowDirs.get(win.id);
}

/**
 * 相対パスをルートディレクトリ配下の絶対パスに解決し、パストラバーサルを検証する。
 * realpath でシンボリックリンクを解決し、ルート外へのアクセスを防ぐ。
 */
async function resolveSecurePath(root: string, relPath: string): Promise<string> {
  const resolved = path.resolve(root, relPath);
  const real = await fs.realpath(resolved);
  const realRoot = await fs.realpath(root);
  const relative = path.relative(realRoot, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Access denied: path is outside workspace root`);
  }
  return real;
}

/**
 * git check-ignore でエントリをフィルタリングする。
 * .gitignore のルールに加え、.git ディレクトリ自体も除外する。
 */
async function filterIgnored(entries: string[], cwd: string): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  try {
    const { stdout } = await execFileAsync("git", ["check-ignore", ...entries], { cwd });
    return new Set(stdout.split("\n").filter(Boolean));
  } catch {
    // git check-ignore は全エントリが非 ignore の場合 exit code 1 を返す
    return new Set();
  }
}

function setupRendererReadyHandler() {
  ipcMain.on("renderer:ready", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const dir = windowDirs.get(win.id);
    if (dir) {
      event.sender.send("orkis:open", dir);
    }
  });
}

/**
 * git status --porcelain=v1 -z を実行し、ファイルパス → ステータスコード（2文字）のマップを返す。
 * -z で NUL 区切り出力にすることで、パス中の特殊文字やスペースを安全にパースする。
 * 削除ファイルも含まれる。
 */
async function getGitStatus(cwd: string): Promise<Record<string, string>> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z"], { cwd });
    const result: Record<string, string> = {};
    const entries = stdout.split("\0");
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      if (!entry) {
        i++;
        continue;
      }
      const status = entry.slice(0, 2);
      const filePath = entry.slice(3);
      // rename (R) / copy (C) は次のエントリに新しいパスが入る
      if (status[0] === "R" || status[0] === "C") {
        i++;
        const newPath = entries[i];
        if (newPath !== undefined) {
          result[newPath] = status;
        }
      } else {
        result[filePath] = status;
      }
      i++;
    }
    return result;
  } catch {
    return {};
  }
}

// ファイル変更時に git status をデバウンスして通知
const gitStatusTimers = new Map<number, ReturnType<typeof setTimeout>>();
// git status の並列実行を防止するための状態管理
const gitStatusInFlight = new Set<number>();
const gitStatusNeedsRerun = new Set<number>();

function scheduleGitStatusUpdate(windowId: number, root: string) {
  const existing = gitStatusTimers.get(windowId);
  if (existing) clearTimeout(existing);

  const GIT_STATUS_DEBOUNCE_MS = 300;
  const timer = setTimeout(async () => {
    gitStatusTimers.delete(windowId);

    // 既に git status 実行中なら再実行フラグを立てて待つ
    if (gitStatusInFlight.has(windowId)) {
      gitStatusNeedsRerun.add(windowId);
      return;
    }

    gitStatusInFlight.add(windowId);
    try {
      const win = BrowserWindow.fromId(windowId);
      if (!win || win.isDestroyed()) return;
      const statuses = await getGitStatus(root);
      win.webContents.send("git:statusChange", statuses);
    } finally {
      gitStatusInFlight.delete(windowId);
      // 実行中にリクエストが来ていた場合は1回だけ再実行
      if (gitStatusNeedsRerun.has(windowId)) {
        gitStatusNeedsRerun.delete(windowId);
        scheduleGitStatusUpdate(windowId, root);
      }
    }
  }, GIT_STATUS_DEBOUNCE_MS);

  gitStatusTimers.set(windowId, timer);
}

function setupGitHandlers() {
  ipcMain.handle("git:status", async (event) => {
    const root = resolveWindowRoot(event);
    if (!root) throw new Error("No workspace root for this window");
    return getGitStatus(root);
  });
}

function setupFsHandlers() {
  ipcMain.handle("fs:readDir", async (event, relPath: string) => {
    const root = resolveWindowRoot(event);
    if (!root) throw new Error("No workspace root for this window");

    const absolutePath = await resolveSecurePath(root, relPath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const visibleEntries = entries.filter((e) => e.name !== ".git");
    const names = visibleEntries.map((e) => e.name);
    const ignored = await filterIgnored(names, absolutePath);

    return visibleEntries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isIgnored: ignored.has(entry.name),
    }));
  });
}

function findWindowByDir(dir: string): BrowserWindow | undefined {
  for (const [id, windowDir] of windowDirs) {
    if (windowDir === dir) {
      return BrowserWindow.fromId(id) ?? undefined;
    }
  }
  return undefined;
}

function handleSocketMessage(message: OrkisMessage) {
  const window = BrowserWindow.getAllWindows()[0];

  switch (message.type) {
    case "hook":
      console.log(`[orkis] hook: ${message.event}`, message.payload);
      window?.webContents.send("orkis:hook", message.event, message.payload);
      break;
    case "open": {
      console.log(`[orkis] open: dir=${message.dir}, file=${message.file ?? "(none)"}`);
      const existing = findWindowByDir(message.dir);
      if (existing) {
        existing.focus();
        existing.webContents.send("orkis:open", message.dir, message.file);
        break;
      }
      const newWindow = createWindow();
      windowDirs.set(newWindow.id, message.dir);
      void startWatching(newWindow.id, message.dir);
      newWindow.on("closed", () => {
        windowDirs.delete(newWindow.id);
        void stopWatching(newWindow.id);
      });
      break;
    }
  }
}

// 単一インスタンス制御: 2つ目のプロセスは即終了し、最初のインスタンスが新しいウィンドウを開く
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    createWindow();
  });

  void app.whenReady().then(() => {
    setupPtyHandlers();
    setupFsHandlers();
    setupGitHandlers();
    setupRendererReadyHandler();
    socketServer = setupSocketServer(handleSocketMessage);

    // CLI から起動された場合はソケット経由の open でウィンドウを作るため、ここでは作らない
    if (!process.env.ORKIS_CLI_LAUNCH) {
      const dir = process.env.ORKIS_PROJECT_ROOT ?? process.cwd();
      handleSocketMessage({ type: "open", dir });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  for (const p of ptys.values()) {
    p.kill();
  }
  ptys.clear();
  for (const subscription of windowWatchers.values()) {
    void subscription.unsubscribe();
  }
  windowWatchers.clear();
  for (const watchedFiles of gitWatchedFiles.values()) {
    for (const filePath of watchedFiles) {
      nodeFs.unwatchFile(filePath);
    }
  }
  gitWatchedFiles.clear();
  if (socketServer) {
    cleanupSocket(socketServer);
  }
});
