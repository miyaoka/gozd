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
 * main window の最小幅 (px)。
 *
 * renderer の横並びレイアウト（Sidebar | ハンドル | 中央カラム | ハンドル | Navigator）が
 * 最小列幅とハンドル 2 本を置き、中央カラムに「Terminal 最小幅 + Preview 最小幅」を
 * 残せる下限。これ未満では Preview popover の描画幅が最小幅を割る（popover は
 * Sidebar のリサイズハンドルを覆わない上限で切られるため）。
 *
 * 内訳の SSOT は renderer の `features/layout/layoutSizes.ts` で、この値が必要十分な
 * 下限であること（1px 狭いと最小幅を割ること）は `layoutSizes.test.ts` が検証する。
 */
export const MIN_WINDOW_WIDTH = 716;

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

/**
 * undock child window (macOS 標準 titlebar) の titlebar 高 (px)。
 *
 * `window.open` の features width/height は外枠サイズとして解釈されるため、コンテンツ高を
 * 指定したい ChildWindow は height にこの分を足す。値は実測 (child window の
 * outer − inner = 32。bounds 検証ログで確認)。
 */
export const CHILD_WINDOW_TITLEBAR_HEIGHT = 32;

/**
 * BrowserWindow の native 背景色。renderer の `bg-background`
 * (design-tokens `--gray-1: oklch(0.231 0 0)`) の sRGB 換算。
 *
 * native 背景は renderer surface の外側で見える色 (生成直後の初回フレーム前 / close 時の
 * surface 破棄後 / リサイズ露出)。既定の白のままだと dark UI で白フラッシュになるため、
 * main が全ウィンドウ (main window / undock child window) の生成時に与える
 * (VS Code が theme 背景色を main 側で全ウィンドウに与えるのと同じ構造)。
 * gozd は dark 固定のため定数で持つ。light theme 追加時は theme 連動へ置き換える。
 */
export const WINDOW_BACKGROUND_COLOR = "#1d1d1d";
