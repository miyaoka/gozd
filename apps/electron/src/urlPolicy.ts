// installExternalLinkPolicy (main.ts) の URL 判定。外部送りのセキュリティ境界のため、
// 純関数に切り出してバイパス文字列の回帰テストを可能にする (urlPolicy.test.ts)。
import { tryCatch } from "@gozd/shared";

/** http(s) スキームか。 */
export function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * OS へ渡してよい URL scheme の allowlist。ブラウザ / メールクライアントで開く想定の
 * scheme のみを許可する（Swift 版 openExternalAllowedSchemes と同一集合）。
 *
 * `/open/external` route（renderer が明示的に撃つ経路）と navigation 防壁（frame が遷移しようと
 * したのを横取りする経路）の両方がこれを参照する。層ごとに別集合を持つと、防壁だけ mailto を
 * 落とすといった非対称が生まれ、どの経路を通ったかで挙動が変わる。
 */
export const EXTERNAL_ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
]);

/** OS へ渡してよい URL か。scheme は `EXTERNAL_ALLOWED_SCHEMES` に限る。 */
function isExternalUrl(url: string): boolean {
  const parsed = tryCatch(() => new URL(url));
  if (!parsed.ok) return false;
  return EXTERNAL_ALLOWED_SCHEMES.has(parsed.value.protocol);
}

/**
 * dev の Vite origin か。origin は完全一致で比較する。prefix 比較
 * (`url.startsWith(rendererUrl)`) だと `http://localhost:5173.evil.example` や
 * `http://localhost:5173@evil.example` (userinfo 扱い) のようなホスト偽装が内部扱いになり、
 * 外部送り境界を突破される。
 *
 * rendererOrigin が undefined なのは packaged で、その場合は一致する URL が存在しない。
 *
 * origin 一致の前に scheme を http(s) に固定する。`new URL("blob:http://host/…").origin` は
 * blob の inner origin (`http://host`) を返すため、origin 比較だけだと `blob:` が内部扱いになる。
 * Vite dev server の URL は必ず http(s) なので、scheme を固定しても取りこぼしはない。
 */
export function isRendererOrigin(url: string, rendererOrigin: string | undefined): boolean {
  if (rendererOrigin === undefined) return false;
  if (!isHttpUrl(url)) return false;
  const parsed = tryCatch(() => new URL(url));
  // parse 不能な文字列は内部と証明できないため外部側に倒す
  if (!parsed.ok) return false;
  return parsed.value.origin === rendererOrigin;
}

/** frame 遷移の扱い。`block` は遷移を止めるだけで外部にも送らない。 */
export type FrameNavigationVerdict = "allow" | "external" | "block";

/**
 * frame 遷移の判定。scheme の allowlist は持たず、**原則すべて block** して例外だけを開ける
 * (VS Code の `app.on("web-contents-created")` が will-navigate を URL も見ずに preventDefault
 * するのと同じ構造)。allowlist 方式だと `file:` / `data:` / `blob:` のように「外部送りではないが
 * 通してもいない」scheme が素通りする。
 *
 * 例外は 2 つだけ。
 *
 * - OS へ渡してよい scheme は外部アプリへ逃がす (`external`)。frame を置換させない点は block と
 *   同じで、遷移の代わりに `shell.openExternal` が走る。ただし subframe は http(s) に絞る。
 *   Chromium / Electron 自身が sandboxed frame からの external protocol 起動を塞いでおり、
 *   防壁が肩代わりするとその保護を迂回するため
 * - dev の Vite origin への **main frame の再読み込み** は通す (`allow`)。Vite の full reload は
 *   `location.reload()` で、これは `will-frame-navigate` を発火するため止めると HMR が壊れる。
 *   例外を「同一 URL への遷移」に絞るのは、同 origin の別 path を通すと rendered content
 *   （session log の assistant markdown 等）の root-relative リンクが dev で Vite origin に解決され、
 *   UI 面が SPA fallback に置換されるため。packaged は `loadFile` で読み込み、リロードも
 *   webContents API 経由でこの判定に到達しないので、例外は dev だけに閉じる
 *
 * subframe は HTML preview の `<iframe srcdoc sandbox="">` だけで、初期 srcdoc から動かないのが
 * 契約なので例外を持たない。内部 origin であっても遷移すればプレビュー面を奪う (dev では
 * previewed HTML の相対リンクが Vite origin に解決され SPA fallback の index.html が返る。
 * sandbox でスクリプトが動かないので白面になる)。
 *
 * 一律 block が HTML preview / undock child window を殺さないのは、`about:srcdoc` や
 * `about:blank` のように URLLoader を経由しない commit がこの判定に到達しないため。到達する
 * ようになるとプレビューは全面が空になり、child window は投影前の文書を失う。手がかりは block の
 * stderr 1 行だけになる。
 */
export function decideFrameNavigation({
  url,
  isMainFrame,
  currentUrl,
  rendererOrigin,
}: {
  url: string;
  isMainFrame: boolean;
  /**
   * webContents の **main frame** が現在読んでいる URL (`contents.getURL()`)。full reload の
   * 判定に使う。subframe 遷移のときも main frame の URL が入るため、subframe 分岐で
   * 「その frame の現在 URL」として読んではいけない。
   */
  currentUrl: string;
  rendererOrigin: string | undefined;
}): FrameNavigationVerdict {
  // 内部 origin は外部送りの対象ではない。main frame の full reload だけ通し、それ以外は止める
  if (isRendererOrigin(url, rendererOrigin)) {
    return isMainFrame && url === currentUrl ? "allow" : "block";
  }
  if (isMainFrame ? isExternalUrl(url) : isHttpUrl(url)) return "external";
  return "block";
}
