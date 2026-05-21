import { tryCatch } from "@gozd/shared";
import type { PathTarget } from "../worktree";

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
 *
 * basePath の `kind` を内部で switch して相対経路 / 絶対経路を分岐する。string sniff (path.startsWith("/"))
 * は使わない。
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
  | {
      kind: "internal";
      selection: PathTarget;
      lineNumber: number | undefined;
      droppedAnchor: boolean;
    }
  | { kind: "passthrough" }
  | { kind: "invalid"; reason: string };

interface ResolveOptions {
  href: string;
  /** 現在のプレビュー対象 selection。base dir 解決に使う。undefined なら worktree root 扱い */
  basePath: PathTarget | undefined;
  /** 親ディレクトリ抽出関数。本番では `relDirOf` を渡す */
  relDirOf: (relPath: string) => string;
  /** 相対パス正規化関数。本番では `normalizeRelative` を渡す */
  normalizeRelative: (relPath: string) => string;
  /** 絶対パス正規化関数。本番では `normalizeAbsolute` を渡す */
  normalizeAbsolute: (absPath: string) => string;
}

/** anchor を解釈して lineNumber と「捨てた anchor があるか」を返す */
function parseAnchor(fragment: string): { lineNumber: number | undefined; droppedAnchor: boolean } {
  if (fragment === "") return { lineNumber: undefined, droppedAnchor: false };
  const decoded = tryCatch(() => decodeURIComponent(fragment));
  const text = decoded.ok ? decoded.value : fragment;
  const match = LINE_FRAGMENT_RE.exec(text);
  if (match === null) return { lineNumber: undefined, droppedAnchor: true };
  const parsed = Number.parseInt(match[1], 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return { lineNumber: undefined, droppedAnchor: true };
  }
  return { lineNumber: parsed, droppedAnchor: false };
}

/**
 * 解決後の worktree 相対パスが worktree root の外を指すかを判定する。
 * `..hidden.md` のような正当な隠しファイル名を巻き込まないよう、
 * `..` 単独 / `..` の後に segment 区切り `/` がある場合のみ「外」とみなす。
 * (絶対パス始まり / `~/` 始まりは normalizeRelative の入力契約上ここには到達しない)
 */
function escapesWorktree(relPath: string): boolean {
  if (relPath === "" || relPath === "..") return true;
  return relPath.startsWith("../");
}

function resolveMarkdownLink({
  href,
  basePath,
  relDirOf,
  normalizeRelative,
  normalizeAbsolute,
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

  // basePath が絶対パス (worktree 外 markdown) のとき、信頼境界を「source file が居る dir 配下」に縮小する。
  // worktree root 基準の escapesWorktree は意味を成さない代わりに、
  // 「normalized が basePath の dir prefix で始まる」ことを唯一の通過条件にする。これにより
  // `/etc/passwd` のような system path への直接 jump と、`../../etc/passwd` のような相対 traversal、
  // および `/Users/<user>/.ssh/id_rsa` のような sibling 領域参照を一律 invalid に倒す。
  if (basePath !== undefined && basePath.kind === "absolute") {
    return resolveWithAbsoluteBase(
      basePath.absPath,
      decodedPath,
      rawFragment,
      href,
      normalizeAbsolute,
    );
  }

  // 相対 basePath 経路 (active worktree 内のファイルを起点とする従来挙動)
  const baseRelPath = basePath?.relPath;
  // `/` 始まり: worktree root 相対として `/` を剥がす / それ以外: basePath dir 相対
  const dir = baseRelPath === undefined ? "" : relDirOf(baseRelPath);
  const combined = decodedPath.startsWith("/")
    ? decodedPath.substring(1)
    : dir === ""
      ? decodedPath
      : `${dir}/${decodedPath}`;

  const normalized = normalizeRelative(combined);

  if (escapesWorktree(normalized)) {
    return { kind: "invalid", reason: `Link target is outside the worktree: ${href}` };
  }

  const { lineNumber, droppedAnchor } = parseAnchor(rawFragment);
  return {
    kind: "internal",
    selection: { kind: "worktreeRelative", relPath: normalized },
    lineNumber,
    droppedAnchor,
  };
}

/**
 * 絶対 basePath 起点の link 解決。relDirOf は worktree 相対契約のため絶対パスでは使わず、
 * 内部で親 dir を抽出する。root 直下のファイル (lastIndexOf("/") === 0) では baseDir を "/" で表現する。
 */
function resolveWithAbsoluteBase(
  baseAbsPath: string,
  decodedPath: string,
  rawFragment: string,
  href: string,
  normalizeAbsolute: (absPath: string) => string,
): ResolvedLink {
  const lastSlash = baseAbsPath.lastIndexOf("/");
  const baseDir = lastSlash <= 0 ? "/" : baseAbsPath.substring(0, lastSlash);

  const combined = decodedPath.startsWith("/")
    ? decodedPath
    : baseDir === "/"
      ? `/${decodedPath}`
      : `${baseDir}/${decodedPath}`;

  const normalized = normalizeAbsolute(combined);

  const isAllowed =
    baseDir === "/"
      ? // root 直下: `/<name>` (slash が 1 つだけ) のみ許可。`/etc/passwd` は invalid。
        normalized.length > 1 && normalized.indexOf("/", 1) === -1
      : // 通常: baseDir 配下のみ許可（baseDir 自身への参照は不可）
        normalized.startsWith(`${baseDir}/`);

  if (!isAllowed) {
    return {
      kind: "invalid",
      reason: `Link target is outside the source file directory: ${href}`,
    };
  }

  const { lineNumber, droppedAnchor } = parseAnchor(rawFragment);
  return {
    kind: "internal",
    selection: { kind: "absolute", absPath: normalized },
    lineNumber,
    droppedAnchor,
  };
}

export { resolveMarkdownLink };
