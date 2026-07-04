import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, type IPty } from "node-pty";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SPIKE_TEST_ARG, type PtySpawnParams } from "./ipc";

const isTestMode = process.env.GOZD_SPIKE_TEST === "1";

const ptys = new Map<number, IPty>();
let nextPtyId = 1;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1080,
    height: 720,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: isTestMode ? [SPIKE_TEST_ARG] : [],
    },
  });
  void window.loadFile(join(__dirname, "renderer/index.html"));
  return window;
}

ipcMain.handle("pty:spawn", (event, params: PtySpawnParams) => {
  const shell = process.env.SHELL ?? "/bin/zsh";
  const id = nextPtyId;
  nextPtyId++;

  const pty = spawn(shell, ["-l"], {
    name: "xterm-256color",
    cols: params.cols,
    rows: params.rows,
    cwd: homedir(),
    env: process.env,
  });
  ptys.set(id, pty);

  const sender = event.sender;
  pty.onData((data) => {
    if (sender.isDestroyed()) return;
    sender.send("pty:data", id, data);
  });
  pty.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (sender.isDestroyed()) return;
    sender.send("pty:exit", id, exitCode);
  });

  return id;
});

ipcMain.on("pty:write", (_event, id: number, data: string) => {
  ptys.get(id)?.write(data);
});

ipcMain.on("pty:resize", (_event, id: number, cols: number, rows: number) => {
  ptys.get(id)?.resize(cols, rows);
});

// spike 自動テスト: renderer からの結果報告を受けてスクリーンショットを残し、exit code に反映する
ipcMain.on("spike:report", (event, ok: boolean, detail: string) => {
  console.log(`[spike] ${ok ? "OK" : "NG"}: ${detail}`);

  const window = BrowserWindow.fromWebContents(event.sender);
  const shotPath = process.env.GOZD_SPIKE_SHOT;
  if (window === null || shotPath === undefined) {
    app.exit(ok ? 0 : 1);
    return;
  }
  void window.webContents.capturePage().then((image) => {
    writeFileSync(shotPath, image.toPNG());
    console.log(`[spike] screenshot: ${shotPath}`);
    app.exit(ok ? 0 : 1);
  });
});

// spike 自動テスト: main プロセスの例外・ハングでもプロセスを残さない
if (isTestMode) {
  process.on("uncaughtException", (error) => {
    console.error(`[spike] uncaughtException: ${error.stack ?? error}`);
    app.exit(1);
  });
  const WATCHDOG_MS = 25000;
  setTimeout(() => {
    console.error("[spike] watchdog timeout: no report received");
    app.exit(2);
  }, WATCHDOG_MS).unref();
}

app.whenReady().then(() => {
  const window = createWindow();
  if (!isTestMode) return;
  console.log("[spike] window created");
  window.webContents.on("did-finish-load", () => {
    console.log("[spike] did-finish-load");
  });
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[spike] did-fail-load: ${code} ${description}`);
    app.exit(1);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  for (const pty of ptys.values()) {
    pty.kill();
  }
});
