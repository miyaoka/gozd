import { tryCatch } from "@gozd/shared";

/**
 * Markdown プレビュー内 `<a>` の href を解決し、内部遷移 / 素通し / 無効のいずれかを返す。
 *
 * scheme 判定は信頼境界として allowlist 方式を採る。Markdown プレビューは
 * リポジトリ内ファイル由来のテキストを描画するため、`gozd-rpc://` / `gozd-app://` /
 * `file:` / `data:` / `javascript:` 等の native or 危険 scheme は明示的に invalid に倒す。
 * passthrough は http(s) / mailto: のみ (外部ブラウザに渡す scheme)。
 *
 * 行番号フラグメント (`#L42`, `#L42,5`, `#42`) は VS Code の `getLocationFragmentFromLinkText`
 * 互換の regex で lineNumber を抽出する。それ以外の anchor (`#section` 等の見出しアンカー) は
 * `droppedAnchor` として呼び出し側に通知する (silent drop を避ける)。
 */

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** Markdown プレビューから外部ブラウザに渡すことを許可する scheme */
const PASSTHROUGH_SCHEMES = ["http:", "https:", "mailto:"];

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

/**
 * 解決後パスが worktree root の外を指すかを判定する。
 * `..hidden.md` のような正当な隠しファイル名を巻き込まないよう、
 * `..` 単独 / `..` の後に segment 区切り `/` がある場合のみ「外」とみなす (同様に `~` も)。
 */
function escapesWorktree(path: string): boolean {
  if (path === "" || path === ".." || path === "~") return true;
  return path.startsWith("../") || path.startsWith("/") || path.startsWith("~/");
}

function resolveMarkdownLink({
  href,
  basePath,
  relDirOf,
  normalizePath,
}: ResolveOptions): ResolvedLink {
  if (href === "") return { kind: "invalid", reason: "Empty link target" };

  // `#` 単独はブラウザの既定挙動 (同一文書内アンカー) に任せる
  if (href.startsWith("#")) return { kind: "passthrough" };

  // scheme 判定: allowlist (http(s) / mailto) のみ passthrough。
  // それ以外の scheme 付き URL は信頼境界を超えるため invalid に倒す。
  const lowered = href.toLowerCase();
  if (PASSTHROUGH_SCHEMES.some((s) => lowered.startsWith(s))) {
    return { kind: "passthrough" };
  }
  if (URL_SCHEME_RE.test(href)) {
    return { kind: "invalid", reason: `Unsupported link scheme: ${href}` };
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

  // basePath が worktree 外の絶対パスのとき、相対リンクは絶対 basePath dir を起点に解決し、
  // 結果も絶対パスのまま返す（escapesWorktree 判定は無意味なのでスキップ）。
  // terminal link 経由で worktree 外 markdown を開いた際、内部の相対リンクが全部
  // invalid に倒れて操作不能になる症状を避ける。
  const isAbsoluteBase = basePath !== undefined && basePath.startsWith("/");

  // `/` 始まり: worktree 内 basePath なら worktree root 相対、絶対 basePath なら絶対パスそのまま
  // それ以外: basePath dir 相対
  let combined: string;
  if (decodedPath.startsWith("/")) {
    combined = isAbsoluteBase ? decodedPath : decodedPath.substring(1);
  } else {
    const dir = basePath === undefined ? "" : relDirOf(basePath);
    combined = dir === "" ? decodedPath : `${dir}/${decodedPath}`;
  }

  const normalized = normalizePath(combined);

  if (!isAbsoluteBase && escapesWorktree(normalized)) {
    return { kind: "invalid", reason: `Link target is outside the worktree: ${href}` };
  }

  const { lineNumber, droppedAnchor } = parseAnchor(rawFragment);
  return { kind: "internal", path: normalized, lineNumber, droppedAnchor };
}

export { resolveMarkdownLink };
