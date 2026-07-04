import { app, BrowserWindow, ipcMain } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SPIKE_TEST_ARG } from "./ipc";
import { createRpcDispatcher, type PushFn } from "./rpcDispatcher";
import { killAllPtys, routes, unwatchAllFsWatches } from "./routes";

const isTestMode = process.env.GOZD_SPIKE_TEST === "1";
// 既存 Vue renderer（Vite dev server）を読む場合に URL を渡す。無指定なら spike ページ
const rendererUrl = process.env.GOZD_ELECTRON_RENDERER_URL;

const dispatch = createRpcDispatcher(routes);

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: isTestMode ? [SPIKE_TEST_ARG] : [],
    },
  });
  if (rendererUrl !== undefined && rendererUrl !== "") {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, "renderer/index.html"));
  }
  return window;
}

ipcMain.handle("rpc:request", (event, path: string, bodyJson: string) => {
  const sender = event.sender;
  const push: PushFn = (type, payload) => {
    if (sender.isDestroyed()) return;
    sender.send("rpc:push", type, payload);
  };
  return dispatch(path, bodyJson, { push });
});

/** スクリーンショットを保存して app を終了する（検証経路の共通処理） */
function captureAndExit(window: BrowserWindow, exitCode: number): void {
  const shotPath = process.env.GOZD_SPIKE_SHOT;
  if (shotPath === undefined) {
    app.exit(exitCode);
    return;
  }
  void window.webContents.capturePage().then((image) => {
    writeFileSync(shotPath, image.toPNG());
    console.log(`[spike] screenshot: ${shotPath}`);
    app.exit(exitCode);
  });
}

// spike 自動テスト: renderer からの結果報告を受けて証跡を残し、exit code に反映する
ipcMain.on("spike:report", (event, ok: boolean, detail: string) => {
  console.log(`[spike] ${ok ? "OK" : "NG"}: ${detail}`);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null) {
    app.exit(ok ? 0 : 1);
    return;
  }
  captureAndExit(window, ok ? 0 : 1);
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

  // 起動検証: 指定 ms 後にスクリーンショットを撮って正常終了する
  // （実 renderer の boot 確認など、spike report 経路が無いページ用）
  const shotAfterMs = process.env.GOZD_SHOT_AFTER_MS;
  if (shotAfterMs !== undefined && shotAfterMs !== "") {
    setTimeout(() => captureAndExit(window, 0), Number(shotAfterMs));
  }

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
  killAllPtys();
  unwatchAllFsWatches();
});
