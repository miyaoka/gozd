import { tryCatch } from "@gozd/shared";

/**
 * Markdown プレビュー内 `<img src>` を、main の配信 scheme の URL に解決する。
 *
 * markdown は renderer の DOM に直接描画するため、相対 src はそのままだと renderer 自身の URL を
 * 基準に解決されて届かない。UI 全体の base は変えられないので src を個別に書き換える。
 *
 * 書き換えるのは scheme を持たない src だけ。scheme 付き (http(s) / data: 等) はそのまま返す。
 * 危険な scheme や配信 scheme を直書きした src は、ここに来る前に sanitizer が落としている。
 */

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** 解決の起点 */
export interface MarkdownImageBase {
  /** 表示中の markdown 自身の配信 URL。相対 src の基準 */
  documentUrl: string;
  /** 配信を許す root の配信 URL（末尾 `/`）。`/` 始まりの src の基準 */
  rootUrl: string;
  /** 配信を許す root の絶対パス。解決先の上限 */
  rootPath: string;
}

/**
 * markdown の URL と、root からの深さで root の URL を導く。URL の組み立て（パスの encode）は
 * main が SSOT なので、renderer では相対 URL の解決だけで root に戻る。
 */
export function markdownImageBase(
  documentUrl: string,
  absPath: string,
  root: string,
): MarkdownImageBase {
  const depth = absPath.slice(root.length + 1).split("/").length - 1;
  return {
    documentUrl,
    rootUrl: new URL("../".repeat(depth) || "./", documentUrl).href,
    rootPath: root,
  };
}

/**
 * 書き換え後の src を返す。読ませない src は undefined を返し、呼び出し側は src を外す
 * （残すと renderer の origin へ無意味な要求が飛ぶ）。
 *
 * - `/` 始まりは root 基準（VS Code の markdown preview が workspace root 基準にするのと同じ）
 * - `//` 始まりは `https:` を補う。renderer の origin の scheme（開発時は http、配布版は file）に
 *   解決先を左右させない
 * - root の外を指すものは読ませない。範囲は main の配信と同じく、pathname を decode して正規化した
 *   パスで判定する。URL 文字列のまま比べると `..%2F` のような encode された区切りが通る
 * - base が未確定（配信 URL の取得前・取得失敗）の相対 src も読ませない
 */
export function resolveMarkdownImageSrc(
  src: string,
  base: MarkdownImageBase | undefined,
  normalizeAbsolute: (absPath: string) => string,
): string | undefined {
  if (src === "" || URL_SCHEME_RE.test(src)) return src;
  if (src.startsWith("//")) return `https:${src}`;
  if (base === undefined) return undefined;

  const fromRoot = src.startsWith("/");
  const parsed = tryCatch(
    () => new URL(fromRoot ? `.${src}` : src, fromRoot ? base.rootUrl : base.documentUrl),
  );
  if (!parsed.ok) return undefined;
  const decoded = tryCatch(() => decodeURIComponent(parsed.value.pathname));
  if (!decoded.ok) return undefined;
  return normalizeAbsolute(decoded.value).startsWith(`${base.rootPath}/`)
    ? parsed.value.href
    : undefined;
}
