import { tryCatch } from "@gozd/shared";

/**
 * Markdown プレビュー内 `<a>` の href を解決し、内部遷移 / 素通し / 無効のいずれかを返す。
 *
 * VS Code (`markdown-language-features/preview-src/index.ts`) と同じ責務分担:
 * - scheme 付き URL (`http://`, `mailto:` 等) と `#fragment` 単独は **素通し**
 *   （`gozd-rpc://` 等の native scheme も含めて、scheme 付きはすべてブラウザの既定挙動に任せる）
 * - scheme 無しは内部リンクとして解決
 *
 * 行番号フラグメント (`#L42`, `#L42,5`, `#42`) は VS Code の `getLocationFragmentFromLinkText` に倣い
 * lineNumber として抽出する。それ以外の anchor (`#section` 等の見出しアンカー) は
 * `droppedAnchor` として呼び出し側に通知する (silent drop を避ける)。
 */

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * VS Code `getLocationFragmentFromLinkText` の正規表現に揃える。
 * `L<n>`, `<n>`, `L<n>,<c>`, `L<n>-L<m>`, `L<n>,<c>-L<m>,<c>` を許容。
 */
const LINE_FRAGMENT_RE = /^L?(\d+)(?:,\d+)?(?:-L?\d+(?:,\d+)?)?$/i;

type ResolvedLink =
  | { kind: "internal"; path: string; lineNumber: number | undefined; droppedAnchor: boolean }
  | { kind: "passthrough" }
  | { kind: "invalid"; reason: string };

interface ResolveOptions {
  href: string;
  /** 現在のプレビュー対象パス (worktree 相対)。base dir 解決に使う。undefined なら worktree root 扱い */
  basePath: string | undefined;
  /** 親ディレクトリ抽出関数。本番では `relDirOf` を渡す */
  relDirOf: (path: string) => string;
  /** パス正規化関数。本番では `normalizePath` を渡す */
  normalizePath: (path: string) => string;
}

/** anchor を解釈して lineNumber と「捨てた anchor があるか」を返す */
function parseAnchor(fragment: string): { lineNumber: number | undefined; droppedAnchor: boolean } {
  if (fragment === "") return { lineNumber: undefined, droppedAnchor: false };
  const decoded = tryCatch(() => decodeURIComponent(fragment));
  const text = decoded.ok ? decoded.value : fragment;
  const match = LINE_FRAGMENT_RE.exec(text);
  if (match === null) return { lineNumber: undefined, droppedAnchor: true };
  const parsed = Number.parseInt(match[1]!, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return { lineNumber: undefined, droppedAnchor: true };
  }
  return { lineNumber: parsed, droppedAnchor: false };
}

function resolveMarkdownLink({
  href,
  basePath,
  relDirOf,
  normalizePath,
}: ResolveOptions): ResolvedLink {
  if (href === "") return { kind: "invalid", reason: "Empty link target" };

  // scheme 付き URL / `#` 単独は WebView の既定挙動に任せる
  if (URL_SCHEME_RE.test(href) || href.startsWith("#")) {
    return { kind: "passthrough" };
  }

  const hashIdx = href.indexOf("#");
  const rawPath = hashIdx >= 0 ? href.substring(0, hashIdx) : href;
  const rawFragment = hashIdx >= 0 ? href.substring(hashIdx + 1) : "";

  // `?query` 単独 / 空白のみは内部経路で扱う対象がないため invalid
  if (rawPath === "" || rawPath.startsWith("?") || rawPath.trim() === "") {
    return { kind: "invalid", reason: `Unsupported link target: ${href}` };
  }

  // path 部に含まれる query string は内部経路では使えないため落とす
  const queryIdx = rawPath.indexOf("?");
  const pathBeforeDecode = queryIdx >= 0 ? rawPath.substring(0, queryIdx) : rawPath;

  const decoded = tryCatch(() => decodeURIComponent(pathBeforeDecode));
  if (!decoded.ok) {
    return { kind: "invalid", reason: `Invalid URL encoding in link: ${href}` };
  }
  const decodedPath = decoded.value;

  // `/` 始まり: worktree ルート相対として扱う / それ以外: selectedPath dir 相対
  let combined: string;
  if (decodedPath.startsWith("/")) {
    combined = decodedPath.substring(1);
  } else {
    const dir = basePath === undefined ? "" : relDirOf(basePath);
    combined = dir === "" ? decodedPath : `${dir}/${decodedPath}`;
  }

  const normalized = normalizePath(combined);

  // worktree root の外を指すリンクは扱わない
  // (絶対パスや `~` で始まる結果は normalizePath 仕様上ここでは到達しないが防御的に落とす)
  if (
    normalized === "" ||
    normalized.startsWith("..") ||
    normalized.startsWith("/") ||
    normalized.startsWith("~")
  ) {
    return { kind: "invalid", reason: `Link target is outside the worktree: ${href}` };
  }

  const { lineNumber, droppedAnchor } = parseAnchor(rawFragment);
  return { kind: "internal", path: normalized, lineNumber, droppedAnchor };
}

export { resolveMarkdownLink };
