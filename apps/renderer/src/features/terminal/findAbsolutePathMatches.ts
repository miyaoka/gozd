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
 * `hasBoundaryBefore` は IDENTIFIER_CHAR の直後だけを弾く。しかし `~` `:` `/` は IDENTIFIER_CHAR
 * ではないため、generic `/` 経路だけで使うとそれぞれ以下の誤検出を起こす:
 * - `~/foo.ts` の `/`: tilde 経路の責務なのに generic でも `/foo.ts` を拾ってしまう
 * - `https://example.com/path` の最初の `/`: URL scheme の `:` 直後で boundary 成立し `//example.com/...` を拾う
 * - `//abs/path` のような連続 slash: 構造的に意味を持たない先頭の `/` を拾う
 *
 * dir/home prefix のような「具体的シグナル」と違い、`/` 単独は構造的に弱いので、これらを呼び出し
 * 側で明示的に除外する。
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
