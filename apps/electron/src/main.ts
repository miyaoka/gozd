import { app, BrowserWindow, ipcMain, screen, shell, type WebContents } from "electron";
import {
  CHILD_WINDOW_FRAME_PREFIX,
  TITLEBAR_HEIGHT,
  tryCatch,
  WINDOW_BACKGROUND_COLOR,
} from "@gozd/shared";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startAppConfigWatcher, stopAppConfigWatcher } from "./appConfigWatcher";
import { registerChildWindow } from "./childWindows";
import { writeClaudeHooksSettings } from "./claudeHooksSettings";
import {
  bundledRendererIndex,
  channel,
  claudeSettingsPath,
  isPackaged,
  launchRequestDir,
  socketPath,
} from "./gozdEnv";
import { GOZD_CHANNEL_ARG_PREFIX, SPIKE_TEST_ARG } from "./ipc";
import { consumeLaunchRequest } from "./launchRequest";
import { installAppMenu } from "./menu";
import { buildGozdOpenPayload } from "./openTarget";
import { createRpcDispatcher, type PushFn } from "./rpcDispatcher";
import {
  killAllPtys,
  routes,
  startPortScanner,
  stopPortScanner,
  unwatchAllFsWatches,
} from "./routes";
import { createSocketMessageHandler } from "./socketMessages";
import { startSocketServer, type SocketServerHandle } from "./socketServer";
import { runSpikeResolverDiag } from "./spikeDiag";
import { isHttpUrl, isInternalUrl } from "./urlPolicy";
import { windowStateStore, type WindowBounds } from "./windowState";

const isTestMode = process.env.GOZD_SPIKE_TEST === "1";

// Vite dev server の URL 解決。GOZD_DEV_VITE_PORT が port の SSOT
// （root の dev script が設定。scheme + host は http://localhost 固定契約）。
// GOZD_ELECTRON_RENDERER_URL は検証用の明示 override
function resolveRendererUrl(): string | undefined {
  const explicit = process.env.GOZD_ELECTRON_RENDERER_URL;
  if (explicit !== undefined && explicit !== "") return explicit;
  const port = process.env.GOZD_DEV_VITE_PORT;
  if (port !== undefined && port !== "") return `http://localhost:${port}`;
  return undefined;
}
const rendererUrl = resolveRendererUrl();
// isInternal の完全一致比較用 (installExternalLinkPolicy 参照)。不正な env 値は起動時に
// fail-loud させる (fallback して黙って外部扱いにすると防壁の誤動作原因が追えない)
const rendererOrigin = rendererUrl !== undefined ? new URL(rendererUrl).origin : undefined;

const dispatch = createRpcDispatcher(routes);

const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 };

// カスタムタイトルバー: titleBarStyle "hiddenInset" でネイティブバーの描画を消し、
// renderer の TitleBar.vue（高さ = @gozd/shared TITLEBAR_HEIGHT が SSOT）が帯を描く。
// 信号機ボタンは window 座標固定のネイティブ部品なので、帯の垂直中央
// （中央 y − ボタン半径）に main 側で位置合わせする
const TRAFFIC_LIGHT_RADIUS = 6;
const TRAFFIC_LIGHT_X = 16;

/** renderer 内リンクの外部送り防壁。Swift 版 ExternalLinkNavigationDecider の対応物。
 * デフォルトでは `<a target="_blank">` が新しい Electron window を開き、main frame の
 * http(s) 遷移は UI 全体を置換してしまうため構造的に必要な防壁。判定軸は Swift 版と
 * 同じ scheme 3 分岐: 内部 origin（dev の Vite URL / packaged の file:）は許可、
 * それ以外の http(s) は OS のデフォルトブラウザへ、その他 scheme は許可。
 *
 * 唯一の例外が `window.open("about:blank")` で、undock 用 child window として許可する
 * （VS Code の auxiliary window と同じ判定軸）。same-origin の about:blank は opener と
 * 同一 renderer プロセスに作られ、中身は opener が DOM 投影で構築する（renderer の
 * ChildWindow.vue）。URL を load しないため「URL 越しにファイルを読む口を作らない」
 * 既存のセキュリティ境界は変わらない。 */
function installExternalLinkPolicy(contents: WebContents): void {
  const openExternal = (url: string): void => {
    // 外部 URL の launch 失敗は具体的な error 込みで stderr に残す（silent drop 禁止）
    void tryCatch(shell.openExternal(url)).then((result) => {
      if (!result.ok) {
        console.error(`[ExternalLink] failed to open external URL: ${url}: ${result.error}`);
      }
    });
  };
  // 判定はセキュリティ境界のため純関数 (urlPolicy.ts) に切り出し、バイパス文字列の
  // 回帰テストで固定している
  const isHttp = isHttpUrl;
  const isInternal = (url: string): boolean => isInternalUrl(url, rendererOrigin);

  // window.open / target="_blank" は about:blank（undock child window）以外は新 window を
  // 作らせない。http(s) のみ外部ブラウザに送り、それ以外は黙って deny。
  // about:blank も frame 名 prefix で first-party の undock 経路に限定する — rendered
  // content 由来の window.open("about:blank") 等を allow すると registry に乗らない
  // 追跡外の空ウィンドウが生まれるため
  contents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === "about:blank" && frameName.startsWith(CHILD_WINDOW_FRAME_PREFIX)) {
      // native 背景をアプリ背景色にする (既定は白)。renderer surface の外で見える色
      // (初回フレーム前 / close 時 / リサイズ露出) の白フラッシュを不可視化する
      return {
        action: "allow",
        overrideBrowserWindowOptions: { backgroundColor: WINDOW_BACKGROUND_COLOR },
      };
    }
    if (isHttp(url)) openExternal(url);
    return { action: "deny" };
  });

  // main frame の遷移。内部 origin（Vite フルリロード等）は許可、外部 http(s) は
  // ブラウザへ、その他 scheme は許可（Swift 版と同じ分岐）
  contents.on("will-navigate", (event, url) => {
    if (isInternal(url) || !isHttp(url)) return;
    event.preventDefault();
    openExternal(url);
  });
}

// 防壁は main window だけでなく about:blank child window（markdown preview のリンクを
// 含む）にも要る。child は createWindow を通らず window.open で生まれるため、生成
// event で全 webContents に一律適用する
app.on("web-contents-created", (_event, contents) => {
  installExternalLinkPolicy(contents);
  // window.open で生まれた child window を frame 名で registry に確保する。
  // タイトル同期（setTitleContext）の除外判定が child を識別するのに使う
  contents.on("did-create-window", (childWindow, details) => {
    if (!details.frameName.startsWith(CHILD_WINDOW_FRAME_PREFIX)) return;
    registerChildWindow(details.frameName, childWindow);
    // renderer は show=no で生成する (ChildWindow.vue)。生成直後に見せると renderer の
    // 初回フレームまでネイティブ背景が見えて白フラッシュするため、初回非空レイアウト
    // (ready-to-show) を待ってから表示する (Electron 公式の flash 回避策)
    childWindow.once("ready-to-show", () => childWindow.show());
    // 表示完了を opener renderer へ push する (payload 型の SSOT は renderer 側
    // ChildWindowShownPayload)。undock 元の後始末 (ゴースト解除 / popover close) の合図。
    // push 欠落 (renderer 再構築中等) は renderer 側の timeout 保険で自己回復するため、
    // ここでは once で送るだけでよい
    childWindow.once("show", () => {
      if (contents.isDestroyed()) return;
      contents.send("rpc:push", "childWindowShown", { frameName: details.frameName });
    });
  });
});

/** 保存 frame がどのディスプレイとも交差しない（外部モニタ取り外し等で off-screen 化）
 * 場合は復元せずデフォルトで開き直すための判定 */
function intersectsAnyDisplay(bounds: WindowBounds): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
}

function createWindow(): BrowserWindow {
  const saved = windowStateStore.loadBounds();
  const restored = saved !== undefined && intersectsAnyDisplay(saved) ? saved : undefined;
  const window = new BrowserWindow({
    width: restored?.width ?? DEFAULT_WINDOW_SIZE.width,
    height: restored?.height ?? DEFAULT_WINDOW_SIZE.height,
    // x / y は undefined ならディスプレイ中央配置（Electron デフォルト）
    x: restored?.x,
    y: restored?.y,
    // native 背景をアプリ背景色にする (起動時、renderer 初回フレームまでの白フラッシュ回避)
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: TITLEBAR_HEIGHT / 2 - TRAFFIC_LIGHT_RADIUS },
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: [
        `${GOZD_CHANNEL_ARG_PREFIX}${channel}`,
        ...(isTestMode ? [SPIKE_TEST_ARG] : []),
      ],
    },
  });
  // frame 保存は will-quit ではなく close で行う: will-quit 時点では window が destroy
  // 済みで bounds を取れない。getNormalBounds は fullscreen / maximize 中でも
  // 通常時 frame を返すため、復元時に巨大 frame が焼き付く事故を避けられる
  window.on("close", () => {
    windowStateStore.saveBounds(window.getNormalBounds());
  });
  // macOS fullscreen では信号機ボタンが消える。renderer のタイトルバー（TitleBar.vue）が
  // 左の逃げ幅 pad を畳めるよう遷移を push する。初期状態の pull hydrate は持たない
  // （取りこぼしても pad が残るだけで、次の遷移で自己回復する cosmetic 用途のため）
  const pushFullscreenChange = (isFullscreen: boolean): void => {
    if (window.webContents.isDestroyed()) return;
    window.webContents.send("rpc:push", "windowFullscreenChange", { isFullscreen });
  };
  window.on("enter-full-screen", () => pushFullscreenChange(true));
  window.on("leave-full-screen", () => pushFullscreenChange(false));
  // ロード経路は 3 つ（Swift 版 GozdApp.task と同型）:
  //   1. GOZD_ELECTRON_RENDERER_URL: Vite dev server（HMR / 検証）
  //   2. packaged: .app 同梱の renderer（Vite build は base "./" のため file:// で成立。
  //      Swift は WebPage に loadFileURL 相当が無く gozd-app:// scheme を要したが、
  //      Electron は loadFile で足りる）
  //   3. fallback: spike テストページ
  if (rendererUrl !== undefined && rendererUrl !== "") {
    void window.loadURL(rendererUrl);
    // dev では esbuild + electron の起動が Vite dev server より速く、初回 load が
    // ERR_CONNECTION_REFUSED になり得る。Vite が上がるまで retry する
    const RETRY_MS = 300;
    window.webContents.on("did-fail-load", (_event, _code, _description, failedUrl) => {
      if (!failedUrl.startsWith(rendererUrl)) return;
      setTimeout(() => void window.loadURL(rendererUrl), RETRY_MS);
    });
  } else if (isPackaged) {
    void window.loadFile(bundledRendererIndex);
  } else {
    void window.loadFile(join(__dirname, "renderer/index.html"));
  }
  return window;
}

ipcMain.handle("rpc:request", (event, path: string, body: unknown) => {
  const sender = event.sender;
  const push: PushFn = (type, payload) => {
    if (sender.isDestroyed()) return;
    sender.send("rpc:push", type, payload);
  };
  return dispatch(path, body, { push });
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

void app.whenReady().then(() => {
  installAppMenu();

  // spike 診断: 実 Electron main が使う git / credential helper を stdout に残す。
  // GOZD_SPIKE_FETCH_DIR=<repo> で起動時 background fetch の再現まで行う（spikeDiag.ts 参照）
  if (isTestMode) {
    void runSpikeResolverDiag();
  }

  // dev の Dock アイコン。packaged は electron-builder が焼いた icns（production 用
  // icon.png 由来）が使われるが、未パッケージ（electron .）は Electron デフォルト
  // アイコンになるため、Swift 期の dev 用アイコン（旧 icon.dev.iconset）を実行時に
  // 当てる。dev / production をアイコンで識別する運用（Swift 期の Gozd-Dev.app 相当）
  if (!isPackaged) {
    const devIconResult = tryCatch(() =>
      app.dock?.setIcon(
        join(__dirname, "..", "resources", "icon.dev.iconset", "icon_512x512@2x.png"),
      ),
    );
    if (!devIconResult.ok) {
      console.error(`[main] failed to set dev dock icon: ${devIconResult.error}`);
    }
  }

  const window = createWindow();

  // Claude hooks 設定 JSON を $TMPDIR に書き出す。PTY の zsh init で claude() 関数が
  // このパスを --settings に注入する。失敗しても PTY は動くため起動は止めない
  try {
    writeClaudeHooksSettings(claudeSettingsPath);
  } catch (error) {
    console.error(`[main] failed to write claude hooks settings: ${String(error)}`);
  }

  // CLI / Claude hooks からの NDJSON を受け付けるソケット server。push は window の
  // webContents に束縛する（gozd はシングルウィンドウ運用）
  const socketPush: PushFn = (type, payload) => {
    if (window.webContents.isDestroyed()) return;
    window.webContents.send("rpc:push", type, payload);
  };
  socketServer = startSocketServer(socketPath, createSocketMessageHandler(socketPush));

  // 実行中サーバーの周期検出。push は window に束縛（シングルウィンドウ運用）
  startPortScanner(socketPush);

  // AppConfig ファイルの hot reload（直接編集を appConfigChange として push）
  startAppConfigWatcher(socketPush);

  // CLI cold start の launch request を消費して gozdOpen を push する
  // （Swift 版 performInitialOpen 対応）。push が renderer の購読登録より先に飛ぶと
  // 落ちるため、page load 完了まで待つ。once なのは Vite フルリロード等の再 load で
  // 再発火させないため（consume 済みなので no-op だが、意味論を Swift の
  // 「起動時 1 回」に揃える）
  window.webContents.once("did-finish-load", () => {
    const target = consumeLaunchRequest(launchRequestDir);
    if (target === undefined) return;
    void buildGozdOpenPayload(target).then((payload) => {
      // undefined = 不在パス（launch request 書き出し後に消えた TOCTOU 等）。push しない
      if (payload === undefined) return;
      socketPush("gozdOpen", payload);
    });
  });

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
  stopPortScanner();
  stopAppConfigWatcher();
  socketServer?.close();
});
