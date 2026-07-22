// main ↔ renderer で共有するウィンドウ chrome のレイアウト契約。

/**
 * カスタムタイトルバー（renderer TitleBar.vue）の高さ (px)。
 *
 * main の trafficLightPosition（信号機ボタンの垂直センタリング）と renderer の
 * 縦レイアウト計算（MainLayout の高さクランプ）が共有する SSOT。
 * CSS 側は renderer main.css の `--titlebar-height` が同値を持つ契約
 * （JS から起動時に注入すると overlay の `top: var(--titlebar-height)` が
 * 初回描画で未解決になり得るため、CSS リテラルとして残し相互参照する）。
 */
export const TITLEBAR_HEIGHT = 36;

/**
 * undock child window の frame 名 prefix。
 *
 * renderer (ChildWindow.vue の `window.open` 第 2 引数) と main
 * (`setWindowOpenHandler` の about:blank allow 判定 / `did-create-window` の registry 登録)
 * が共有する SSOT。first-party の undock 経路だけを allow し、それ以外の
 * `window.open("about:blank")` (rendered content 由来等) は追跡外の空ウィンドウに
 * なるため deny する。
 */
export const CHILD_WINDOW_FRAME_PREFIX = "gozd-child-";
