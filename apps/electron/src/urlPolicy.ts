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
 * will-navigate の外部送り境界を突破される。
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
