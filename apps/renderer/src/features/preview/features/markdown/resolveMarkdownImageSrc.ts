import { tryCatch } from "@gozd/shared";
import type { PreviewServingTarget } from "../../previewServingTarget";

/**
 * Markdown プレビュー内の画像の URL（`src` と `srcset` の各候補）を、main の配信 scheme の URL に解決する。
 *
 * markdown は renderer の DOM に直接描画するため、相対 src はそのままだと renderer 自身の URL を
 * 基準に解決されて届かない。UI 全体の base は変えられないので src を個別に書き換える。
 *
 * 書き換えるのは scheme を持たない src だけ。scheme 付きは `keepAllowedImageScheme` に従う。
 */

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const ALLOWED_IMAGE_SCHEME_RE = /^(?:https?|data):/i;
/** C0 制御文字と空白の上限（U+0000〜U+0020） */
const MAX_C0_OR_SPACE = 0x20;
const TAB_OR_NEWLINE_RE = /[\t\n\r]/g;

/**
 * URL パーサが解析の前に行う正規化（WHATWG URL Standard の basic URL parser: 先頭と末尾の
 * C0 制御文字と空白を除き、途中のタブと改行を除く）。scheme の判定はブラウザが読む形に対して
 * 行う。生の文字列で判定すると `\x01gozd-preview:` や `gozd-pre\tview:` が scheme 無しに見える
 */
function normalizeLikeUrlParser(url: string): string {
  let start = 0;
  let end = url.length;
  while (start < end && url.charCodeAt(start) <= MAX_C0_OR_SPACE) start++;
  while (end > start && url.charCodeAt(end - 1) <= MAX_C0_OR_SPACE) end--;
  return url.slice(start, end).replace(TAB_OR_NEWLINE_RE, "");
}

/**
 * scheme 付きの画像 URL は http(s) / data: だけを残し、それ以外（配信 scheme の直書き、file: 等）は
 * undefined にする。scheme の無い URL はそのまま返す。
 *
 * sanitizer の URI allowlist は属性値の先頭しか見ないため、srcset の 2 つ目以降の候補に書かれた
 * scheme は素通りする。画像の URL は候補ごとにここを通す。
 */
export function keepAllowedImageScheme(url: string): string | undefined {
  const normalized = normalizeLikeUrlParser(url);
  if (!URL_SCHEME_RE.test(normalized)) return url;
  return ALLOWED_IMAGE_SCHEME_RE.test(normalized) ? normalized : undefined;
}

/** 解決の起点 */
export interface MarkdownImageBase {
  /** 表示中の markdown 自身の配信 URL。相対 src の基準 */
  documentUrl: string;
  /** 配信を許す root の配信 URL（末尾 `/`）。`/` 始まりの src を root 基準で解く場合の基準 */
  rootUrl: string;
  /** 配信を許す root の絶対パス。解決先の上限 */
  rootPath: string;
  /** `/` 始まりの src の基準。`root` は配信 root、`filesystem` はファイルシステムの絶対パス */
  slashBase: "root" | "filesystem";
}

/**
 * markdown の URL と、root からの深さで root の URL を導く。URL の組み立て（パスの encode）は
 * main が SSOT なので、renderer では相対 URL の解決だけで root に戻る。
 */
export function markdownImageBase(
  documentUrl: string,
  target: PreviewServingTarget,
): MarkdownImageBase {
  const depth = target.absPath.slice(target.root.length + 1).split("/").length - 1;
  return {
    documentUrl,
    rootUrl: new URL("../".repeat(depth) || "./", documentUrl).href,
    rootPath: target.root,
    // worktree 外の markdown はリンクの解決と同じく `/` をファイルシステムの絶対パスとして読む
    slashBase: target.scope === "worktree" ? "root" : "filesystem",
  };
}

/** 書き換え後の画像の URL */
export interface ResolvedImageSrc {
  url: string;
  /** 配信 scheme で読む画像の絶対パス。外部 URL・data: では undefined */
  servedPath?: string;
}

/**
 * 書き換え後の src を返す。読ませない src は undefined を返し、呼び出し側は src を外す
 * （残すと renderer の origin へ無意味な要求が飛ぶ）。
 *
 * - `/` 始まりは、worktree 内の markdown なら worktree root 基準（VS Code の markdown preview が
 *   workspace root 基準にするのと同じ）、worktree 外ならファイルシステムの絶対パス。どちらも
 *   リンクの解決（`resolveMarkdownLink`）と同じ基準
 * - `//` 始まりは `https:` を補う。renderer の origin の scheme（開発時は http、配布版は file）に
 *   解決先を左右させない
 * - root の外を指すものは読ませない。範囲は main の配信と同じく、pathname を decode して正規化した
 *   パスで判定する。URL 文字列のまま比べると `..%2F` のような encode された区切りが通る
 * - 解決先が自分の preview の origin でなければ読ませない。パスが root 配下でも、別の preview の
 *   配信 URL（別の host）に届くと、その preview の配信範囲を読める
 * - base が未確定（配信 URL の取得前・取得失敗）の相対 src も読ませない
 */
export function resolveMarkdownImageSrc(
  src: string,
  base: MarkdownImageBase | undefined,
  normalizeAbsolute: (absPath: string) => string,
): ResolvedImageSrc | undefined {
  const normalized = normalizeLikeUrlParser(src);
  if (normalized === "") return { url: src };
  if (URL_SCHEME_RE.test(normalized)) {
    const kept = keepAllowedImageScheme(normalized);
    return kept === undefined ? undefined : { url: kept };
  }
  if (normalized.startsWith("//")) return { url: `https:${normalized}` };
  if (base === undefined) return undefined;

  const fromRoot = normalized.startsWith("/") && base.slashBase === "root";
  const parsed = tryCatch(
    () =>
      new URL(fromRoot ? `.${normalized}` : normalized, fromRoot ? base.rootUrl : base.documentUrl),
  );
  if (!parsed.ok) return undefined;
  const document = new URL(base.documentUrl);
  if (parsed.value.protocol !== document.protocol || parsed.value.host !== document.host) {
    return undefined;
  }
  const decoded = tryCatch(() => decodeURIComponent(parsed.value.pathname));
  if (!decoded.ok) return undefined;
  const servedPath = normalizeAbsolute(decoded.value);
  return servedPath.startsWith(`${base.rootPath}/`)
    ? { url: parsed.value.href, servedPath }
    : undefined;
}
