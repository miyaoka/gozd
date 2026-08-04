// installExternalLinkPolicy (main.ts) の URL 判定。外部送りのセキュリティ境界のため、
// 純関数に切り出してバイパス文字列の回帰テストを可能にする (urlPolicy.test.ts)。
import { tryCatch } from "@gozd/shared";

/** http(s) スキームか。外部ブラウザへ送る対象の判定。 */
export function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * 内部 origin (renderer) か。origin は完全一致で比較する。prefix 比較
 * (`url.startsWith(rendererUrl)`) だと `http://localhost:5173.evil.example` や
 * `http://localhost:5173@evil.example` (userinfo 扱い) のようなホスト偽装が内部扱いになり、
 * 外部送り境界を突破される。
 *
 * rendererOrigin は dev の Vite origin。packaged (undefined) は loadFile 経由の
 * file: origin だけが内部。
 */
export function isInternalUrl(url: string, rendererOrigin: string | undefined): boolean {
  const parsed = tryCatch(() => new URL(url));
  // parse 不能な文字列は内部と証明できないため外部側に倒す
  if (!parsed.ok) return false;
  if (rendererOrigin !== undefined && parsed.value.origin === rendererOrigin) return true;
  return parsed.value.protocol === "file:";
}

/** frame 遷移の扱い。`block` は遷移を止めるだけで外部にも送らない。 */
export type FrameNavigationVerdict = "allow" | "external" | "block";

/**
 * frame 遷移の判定。main frame と subframe で軸が違う。
 *
 * main frame は UI 本体で、内部 origin への遷移 (dev の Vite フルリロード等) を通す必要がある。
 * subframe は HTML preview の `<iframe srcdoc sandbox="">` だけで、初期 srcdoc から動かないのが
 * 契約。内部 origin であっても遷移すればプレビュー面を奪うため (dev では previewed HTML の相対
 * リンクが Vite origin に解決され SPA fallback の index.html が返る。sandbox でスクリプトが
 * 動かないので白面になる)、外部送り以外は一律 block する。
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
  const isExternal = isHttpUrl(url) && !isInternalUrl(url, rendererOrigin);
  if (isExternal) return "external";
  return isMainFrame ? "allow" : "block";
}
