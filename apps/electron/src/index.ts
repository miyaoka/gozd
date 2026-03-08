import { app, shell, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type net from "node:net";
import * as pty from "node-pty";
import { cleanupSocket, setupSocketServer, type OrkisMessage } from "./socket-server";

const ptys = new Map<number, pty.IPty>();
let nextPtyId = 0;

function setupPtyHandlers() {
  ipcMain.handle("pty:spawn", (event, cols: number, rows: number) => {
    const id = nextPtyId++;
    const shell = process.env.SHELL ?? "zsh";
    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME,
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
      newWindow.on("closed", () => {
        windowDirs.delete(newWindow.id);
      });
      newWindow.webContents.once("did-finish-load", () => {
        newWindow.webContents.send("orkis:open", message.dir, message.file);
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
    socketServer = setupSocketServer(handleSocketMessage);

    // CLI から起動された場合はソケット経由の open でウィンドウを作るため、ここでは作らない
    if (!process.env.ORKIS_CLI_LAUNCH) {
      createWindow();
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
  if (socketServer) {
    cleanupSocket(socketServer);
  }
});
