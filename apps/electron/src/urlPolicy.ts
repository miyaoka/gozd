// installExternalLinkPolicy (main.ts) の URL 判定。外部送りのセキュリティ境界のため、
// 純関数に切り出してバイパス文字列の回帰テストを可能にする (urlPolicy.test.ts)。
import { tryCatch } from "@gozd/shared";

/** http(s) スキームか。外部ブラウザへ送る対象の判定。 */
export function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
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
 * - 外部 http(s) は OS ブラウザへ逃がす (`external`)。frame を置換させない点は block と同じ
 * - dev の Vite origin への **main frame** 遷移は通す (`allow`)。Vite の full reload は
 *   `location.reload()` で、これは `will-frame-navigate` を発火するため止めると HMR が壊れる。
 *   packaged は `loadFile` で読み込み、リロードも webContents API 経由でこの判定に到達しないため、
 *   例外は dev だけに閉じる
 *
 * subframe は HTML preview の `<iframe srcdoc sandbox="">` だけで、初期 srcdoc から動かないのが
 * 契約なので例外を持たない。内部 origin であっても遷移すればプレビュー面を奪う (dev では
 * previewed HTML の相対リンクが Vite origin に解決され SPA fallback の index.html が返る。
 * sandbox でスクリプトが動かないので白面になる)。
 *
 * subframe を一律 block しても HTML preview が死なないのは、`srcdoc` の初期ロードが URLLoader を
 * 経由せず `will-frame-navigate` に到達しないため。`about:srcdoc` がこの判定に届くようになると
 * プレビューは全面が空になり、手がかりは block の stderr 1 行だけになる。
 */
export function decideFrameNavigation({
  url,
  isMainFrame,
  rendererOrigin,
}: {
  url: string;
  isMainFrame: boolean;
  rendererOrigin: string | undefined;
}): FrameNavigationVerdict {
  // 内部 origin は外部送りの対象ではない。main frame の full reload だけ通し、subframe は止める
  if (isRendererOrigin(url, rendererOrigin)) return isMainFrame ? "allow" : "block";
  if (isHttpUrl(url)) return "external";
  return "block";
}
