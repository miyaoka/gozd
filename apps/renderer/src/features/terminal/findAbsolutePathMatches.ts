import { pathTargetToString, type PathTarget } from "../worktree";
import { parseLineNumberSuffix } from "./parseLineNumberSuffix";

/**
 * パスの末尾区切り文字。シェルで unquoted なパスに現れない文字を区切りとする。
 *
 * ベース: VS Code terminalLinkParsing の Unix 版 ExcludedPathCharacters
 * （`<` `>` `?` `\s` `!` `` ` `` `&` `*` `(` `)` `'` `"` `:` `;` `\`）。
 * リダイレクト / サブシェル / コマンド置換 / glob / 履歴展開 / エスケープ / 引用符 / 行番号区切り。
 *
 * gozd 独自の追加（存在検証をしないため誤検出を区切りで抑える）:
 * - `#`: コメント / URL fragment
 * - `|` `$`: パイプ / 変数展開（VS Code Unix 版には無いが強い区切り）
 * - `{` `}` `[` `]` `,`: log 出力がパスを囲む慣習への対応（開き／閉じ対称に扱う）
 *
 * VS Code が持つ `\0`(NUL) は xterm バッファに来ない前提で除外。
 */
export const PATH_TERMINATORS = /[\s<>(){}[\]'"|&`$,:;#!*?\\]/;

/** パスの直後に `:行番号` が続くかを検出する正規表現 */
const LINE_NUMBER_SUFFIX = /^:(\d+)/;

/**
 * 識別子（連続トークン）を構成する文字。prefix の直前にこの文字があれば、prefix は
 * より大きなトークンの途中（URL の `…com/Users`、別ユーザー名 `me_other` 等）なので
 * boundary を立てない。逆に `[` `{` `<` `(` `'` `"` `=` のような非識別子文字が直前なら boundary 成立。
 *
 * PATH_TERMINATORS（パス末尾を区切る文字）とは論理的に独立した別軸であり、1 つの集合に畳めない:
 * - PATH_TERMINATORS: 「この文字はパスを終わらせるか」
 * - IDENTIFIER_CHAR : 「この文字の直後にパスが始まってよいか（＝識別子の途中でないか）」
 *
 * 同じ文字でも両者で扱いが違う。例: `=` はパスを終わらせない（IDENTIFIER_CHAR でもない）が、
 * `f=/Users/…` のようにパスの直前には立てる。`.` も同様。両者を統合すると `f=/path` 形式が
 * 拾えなくなる（直前の `=` が「終端文字でない＝boundary でない」に倒れるため）。
 */
const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;

/** prefix が単語境界の直後で始まっているか（URL の path 部分のような連続 token 内では拾わない） */
function hasBoundaryBefore(text: string, idx: number): boolean {
  if (idx === 0) return true;
  return !IDENTIFIER_CHAR.test(text[idx - 1]);
}

/** boundary が立っている prefix の出現位置を search start から探す */
function indexOfWithBoundary(text: string, prefix: string, start: number): number {
  let idx = text.indexOf(prefix, start);
  while (idx !== -1) {
    if (hasBoundaryBefore(text, idx)) return idx;
    idx = text.indexOf(prefix, idx + 1);
  }
  return -1;
}

/**
 * generic `/` 経路（dir/home/tilde にマッチしないシステムパス用フォールバック）の boundary 判定。
 *
 * dir/home/tilde prefix のような「具体的シグナル」と違い、`/` 単独は構造的に弱いシグナルなので、
 * `hasBoundaryBefore`（IDENTIFIER_CHAR 直後を除外）に加えて、**直前文字によって path 先頭の `/` が
 * 構造的に無意味化されるケース**を追加除外する。除外集合は以下の原理で導出される:
 *
 * - 直前 `~`: 続く `/` は tilde 展開経路（`~/...`）の責務であり、generic で重複して拾うべきでない
 * - 直前 `:`: 続く `/` は URI scheme（`http:` `file:` `git:` 等の `:/...` `://...`）の構造の一部であり、
 *   path 先頭ではない
 * - 直前 `/`: 既に手前の `/` が path 先頭として評価された後の連続 slash の冗長防御。
 *   実挙動として、行頭 `//abs/path` のような実入力では先頭 `/`（idx=0、prev=""）が起点として
 *   採用され、findPathEnd が連続 slash を含む全体を 1 path として消費するため、2 つ目の `/`
 *   判定はそもそも経由しない（VSCode の unixLocalLinkClause `(\/+ Char+)+` が連続 slash を
 *   path separator として許容するのと等価）。この規律は searchStart 進行（push 後の totalEnd
 *   への移動）で再起動後に「過去 path に消費されていた連続 `/` を新規 path 起点として再採用
 *   しない」ための冗長防御として機能する
 *
 * 他の非 IDENTIFIER_CHAR 直前文字（`[` `{` `<` `(` `'` `"` `=` `.` 等）は、path 先頭の `/` を
 * 無意味化しない（cli option `--path=/foo`、引用符 `'/path'`、log 括弧 `[/path]` 等で path として
 * 意味を持つ）ため除外しない。新規偽陽性が見つかった場合は、上記原理（path 先頭シグナルとして
 * 無意味化されるか）に照らして判断する。
 *
 * 実在検証はしない契約。単一セグメント `/etc` `/tmp` 等は `absolute` として返す（クリック時の
 * Preview 側で実在しない / ディレクトリの場合はエラーとして notification される）。一方、root
 * `/` 単独 / `/<terminator>` / `///` `////` のような連続 slash のみで構成されるケースは「`/` 以外の
 * path 文字を 1 つも含まない」ため path として構造的に意味を持たず、findAbsolutePathMatches 側で
 * push 直前に弾く（VSCode の unixLocalLinkClause `(\/+ Char+)+` が「1 つ以上の `/` + 1 つ以上の
 * path 文字」を最低 1 セグメント構造要求するのと等価）。
 */
function indexOfGenericSlash(text: string, start: number): number {
  let idx = text.indexOf("/", start);
  while (idx !== -1) {
    if (hasBoundaryBefore(text, idx)) {
      const prev = idx > 0 ? text[idx - 1] : "";
      if (prev !== "~" && prev !== ":" && prev !== "/") return idx;
    }
    idx = text.indexOf("/", idx + 1);
  }
  return -1;
}

export interface AbsolutePathMatch {
  /** マッチ全体の開始位置（行番号サフィックスも含む） */
  idx: number;
  /** マッチ全体の終了位置（行番号サフィックスも含む） */
  totalEnd: number;
  /** 選択ターゲット（worktree 内なら relPath、worktree 外なら absPath） */
  selection: PathTarget;
  /** パス直後の `:N` から取り出した 1-based 行番号 */
  lineNumber?: number;
}

/** パスの末尾位置を探す（区切り文字 or 行末まで） */
function findPathEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && !PATH_TERMINATORS.test(text[end])) {
    end++;
  }
  return end;
}

/** [start, end) 範囲に `/` 以外の文字が 1 つ以上含まれるか */
function hasNonSlashChar(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (text[i] !== "/") return true;
  }
  return false;
}

/**
 * `~/` プレフィックスを展開するために、dirPrefix からホームディレクトリを推定する。
 * dirPrefix が `/Users/miyaoka/...` のような形式なら `/Users/miyaoka` を返す。
 * gozd は macOS 専用のため `/Users/<user>` のみ対象とする。
 */
export function resolveHomeDir(dirPrefix: string): string {
  const match = dirPrefix.match(/^(\/Users\/[^/]+)\//);
  return match ? match[1] : "";
}

/**
 * テキストから絶対パスマッチを収集する純粋関数。
 * dirPrefix / homePrefix / `~/` / generic `/` の 4 つを indexOf で並列に探し、最も手前の
 * マッチを採用する。generic `/` は worktree 内 / home 内に収まらないパス（`/tmp/...`
 * `/var/folders/...` `/usr/local/...` 等）を拾うためのフォールバック経路。
 *
 * dirPrefix は homePrefix を内包しうる（dirPrefix が `/Users/<user>/` 配下なら、文字列として
 * 部分一致する）。同 idx 衝突時は prefixLen の長い方を採用することで「より具体的な prefix を
 * 優先する」規律を明示する（dir > home > generic `/`、Array.prototype.sort の stability に依存しない）。
 *
 * dirPrefix が `/tmp/...` のように homeDir 外のケースもあるため、dirPrefix も独立に検索する。
 *
 * prefix 部分は走査対象から除外する（`idx + prefixLen` から findPathEnd を開始）。worktree
 * dir 名に空白や括弧などが入っていてもパスが prefix 途中で切れない。generic `/` 経路は
 * prefixLen=0 なので `/` 自体も走査対象に含まれる（findPathEnd の PATH_TERMINATORS に `/` は
 * 含まれないため `/tmp/foo.txt` 全体が拾われる）。
 *
 * boundary check（hasBoundaryBefore）は generic `/` 経路にも適用されるため、URL の path 部分
 * （`https://example.com/Users/...` の `/` は直前が `m` で識別子文字）は構造的に弾かれる。
 */
export function findAbsolutePathMatches(
  text: string,
  dirPrefix: string,
  homeDir: string,
): AbsolutePathMatch[] {
  const homePrefix = homeDir ? `${homeDir}/` : "";
  const matches: AbsolutePathMatch[] = [];
  let searchStart = 0;

  while (searchStart < text.length) {
    // 単語境界の直後（行頭 / 区切り文字直後）でのみ拾う。これにより
    // `https://example.com/Users/<user>/foo` の `/Users/...` 部分のような URL 内 path を
    // 絶対パスとして誤検出しない。
    const candidates: Array<{ idx: number; prefixLen: number; expandTilde: boolean }> = [];
    const dirIdx = indexOfWithBoundary(text, dirPrefix, searchStart);
    if (dirIdx !== -1) {
      candidates.push({ idx: dirIdx, prefixLen: dirPrefix.length, expandTilde: false });
    }
    if (homePrefix) {
      const homeIdx = indexOfWithBoundary(text, homePrefix, searchStart);
      if (homeIdx !== -1) {
        candidates.push({ idx: homeIdx, prefixLen: homePrefix.length, expandTilde: false });
      }
      const tildeIdx = indexOfWithBoundary(text, "~/", searchStart);
      if (tildeIdx !== -1) {
        candidates.push({ idx: tildeIdx, prefixLen: 2, expandTilde: true });
      }
    }
    const slashIdx = indexOfGenericSlash(text, searchStart);
    if (slashIdx !== -1) {
      candidates.push({ idx: slashIdx, prefixLen: 0, expandTilde: false });
    }

    if (candidates.length === 0) break;

    // idx 昇順、同 idx なら prefixLen 降順（dir > home > tilde > generic `/`）
    candidates.sort((a, b) => a.idx - b.idx || b.prefixLen - a.prefixLen);
    const { idx, prefixLen, expandTilde } = candidates[0];

    const pathEnd = findPathEnd(text, idx + prefixLen);

    // generic `/` 経路 (prefixLen === 0) は構造的シグナルが弱いため、最低 1 セグメント
    // (`/foo`) を要求する。VSCode の unixLocalLinkClause `(\/+ Char+)+` は「1 つ以上の `/` +
    // 1 つ以上の path 文字」を最低 1 セグメント構造要求するので、これと等価に「`/` 以外の
    // path 文字を 1 つ以上含む」ことを要求する。`/` 単独 / `/<terminator>` / `///` `////` のような
    // 連続 slash のみで構成されるケースは弾く。VSCode は最後に stat で実在検証して短い偽
    // パスを弾けるが、gozd には検証層が無いため、検出側で path 構造として無意味なケースだけ
    // は明示的に除外する。
    if (prefixLen === 0 && !hasNonSlashChar(text, idx, pathEnd)) {
      searchStart = idx + 1;
      continue;
    }

    const fullPath = expandTilde
      ? `${homeDir}/${text.slice(idx + prefixLen, pathEnd)}`
      : text.slice(idx, pathEnd);

    // パス直後の `:行番号` を SSOT 関数 (parseLineNumberSuffix) で validate する。
    // `:0` や Number.isSafeInteger 外は suffix は consume するが lineNumber は undefined。
    const lineMatch = LINE_NUMBER_SUFFIX.exec(text.slice(pathEnd));
    const lineNumber = lineMatch ? parseLineNumberSuffix(lineMatch[1]) : undefined;
    const totalEnd = lineMatch ? pathEnd + lineMatch[0].length : pathEnd;

    const selection: PathTarget = fullPath.startsWith(dirPrefix)
      ? { kind: "worktreeRelative", relPath: fullPath.slice(dirPrefix.length) }
      : { kind: "absolute", absPath: fullPath };

    const display = pathTargetToString(selection);
    if (display.length > 0) {
      matches.push({ idx, totalEnd, selection, lineNumber });
    }

    searchStart = totalEnd;
  }

  return matches;
}
