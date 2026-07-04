import { app, BrowserWindow, ipcMain } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeClaudeHooksSettings } from "./claudeHooksSettings";
import { registerFileServerProtocol } from "./fileServer";
import { claudeSettingsPath, socketPath } from "./gozdEnv";
import { SPIKE_TEST_ARG } from "./ipc";
import { createRpcDispatcher, type PushFn } from "./rpcDispatcher";
import { killAllPtys, routes, unwatchAllFsWatches } from "./routes";
import { createSocketMessageHandler } from "./socketMessages";
import { startSocketServer, type SocketServerHandle } from "./socketServer";

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

let socketServer: SocketServerHandle | undefined;

app.whenReady().then(() => {
  // protocol 登録は window の loadURL より先に行う（先に読み込まれた <img> が
  // 未登録 scheme として即 error になるのを避ける）
  registerFileServerProtocol();

  const window = createWindow();

  // Claude hooks 設定 JSON を $TMPDIR に書き出す。PTY の zsh init で claude() 関数が
  // このパスを --settings に注入する。失敗しても PTY は動くため起動は止めない
  try {
    writeClaudeHooksSettings(claudeSettingsPath);
  } catch (error) {
    console.error(`[main] failed to write claude hooks settings: ${error}`);
  }

  // CLI / Claude hooks からの NDJSON を受け付けるソケット server。push は window の
  // webContents に束縛する（gozd はシングルウィンドウ運用）
  const socketPush: PushFn = (type, payload) => {
    if (window.webContents.isDestroyed()) return;
    window.webContents.send("rpc:push", type, payload);
  };
  socketServer = startSocketServer(socketPath, createSocketMessageHandler(socketPush));

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
  socketServer?.close();
});
