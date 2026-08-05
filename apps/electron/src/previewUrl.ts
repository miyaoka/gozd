// HTML preview の配信 URL の契約（scheme 名 / preview id / URL の組み立て・分解）。
//
// 配信の実装 (previewProtocol.ts) は electron に依存するが、navigation 防壁の判定
// (urlPolicy.ts) と RPC 入口の検証は純関数として bun test から呼ぶ。両者が同じ契約を
// 見るための SSOT を electron 非依存の位置に置く。
import { tryCatch } from "@gozd/shared";
import { normalize } from "node:path";

export const PREVIEW_SCHEME = "gozd-preview";

/**
 * `previewId` が URL の host として使えるか。
 *
 * host は URL パーサが正規化する（大文字は小文字化される）。配信許可の登録キーは生の id なので、
 * 正規化で変わる文字が混じると「登録は成功するのに配信だけ 403」になり、ログには out-of-root と
 * しか出ず原因が見えない。生成元を変えても壊れないよう入口で固定する。
 */
export function isValidPreviewId(previewId: string): boolean {
  return /^[a-z0-9-]+$/.test(previewId);
}

/**
 * 絶対パスから preview URL を組み立てる（renderer が iframe src に使う形）。
 *
 * host 部に preview instance の id を置くことで **origin が preview ごとに分かれる**。
 * host を固定値にすると全 preview が同一 origin になり、CSP の `'self'` が preview 間の壁に
 * ならない。複数 repo の同居は gozd の機能要件なので、preview A の HTML から
 * `<img src="gozd-preview://<B の id>/<repo B のパス>">` と書けば B 側のファイルが描画できて
 * しまう。origin が分かれていれば、その参照は A から見て cross-origin になり `img-src 'self'`
 * が弾く。
 *
 * VS Code の webview が `vscode-webview://<parentOriginHash(parentOrigin, webview.origin)>` で
 * origin を webview ごとに分け、リソース解決もその webview の `localResourceRoots` だけで
 * 行っているのと同じ形（`webviewElement.ts` の `loadLocalResource` 呼び出し）。
 */
export function pathToPreviewUrl(absPath: string, previewId: string): string {
  // path segment ごとに encode する。`#` や `?` を含むファイル名が fragment / query に
  // 化けるのを防ぐ（`/` は区切りとして残す）
  const encoded = absPath.split("/").map(encodeURIComponent).join("/");
  return `${PREVIEW_SCHEME}://${previewId}${encoded}`;
}

/** preview URL を要求元 preview の id と配信対象の絶対パスに分解する。非絶対は undefined */
export function parsePreviewUrl(url: string): { previewId: string; path: string } | undefined {
  const parsed = tryCatch(() => new URL(url));
  if (!parsed.ok) return undefined;
  if (parsed.value.protocol !== `${PREVIEW_SCHEME}:`) return undefined;
  if (parsed.value.hostname === "") return undefined;
  const decoded = tryCatch(() => decodeURIComponent(parsed.value.pathname));
  if (!decoded.ok) return undefined;
  // pathname は必ず `/` 始まり。POSIX 絶対パスとしてそのまま使う
  if (!decoded.value.startsWith("/")) return undefined;
  return { previewId: parsed.value.hostname, path: normalize(decoded.value) };
}
