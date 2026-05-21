/** パスの末尾区切り文字 */
const PATH_TERMINATORS = /[\s()}\]>'",:;]/;

/** パスの直後に `:行番号` が続くかを検出する正規表現 */
const LINE_NUMBER_SUFFIX = /^:(\d+)/;

export interface AbsolutePathMatch {
  /** マッチ全体の開始位置（行番号サフィックスも含む） */
  idx: number;
  /** マッチ全体の終了位置（行番号サフィックスも含む） */
  totalEnd: number;
  /** worktree 内なら相対パス、worktree 外なら絶対パス */
  selectPath: string;
  /** パス直後の `:N` から取り出した 1-based 行番号 */
  lineNumber?: number;
}

/** パスの末尾位置を探す（区切り文字 or 行末まで） */
function findPathEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && !PATH_TERMINATORS.test(text[end]!)) {
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
  return match ? match[1]! : "";
}

/**
 * テキストから絶対パスマッチを収集する純粋関数。
 * dirPrefix / homePrefix / `~/` の 3 つを indexOf で並列に探し、最も手前のマッチを採用する。
 *
 * dirPrefix は homePrefix を内包しうる（dirPrefix が `/Users/<user>/` 配下なら、文字列として
 * 部分一致する）。同 idx 衝突時は prefixLen の長い方を採用することで「dir-prefix 相対化を
 * 優先する」規律を明示する（Array.prototype.sort の stability に依存しない）。
 *
 * dirPrefix が `/tmp/...` のように homeDir 外のケースもあるため、dirPrefix も独立に検索する。
 *
 * prefix 部分は走査対象から除外する（`idx + prefixLen` から findPathEnd を開始）。worktree
 * dir 名に空白や括弧などが入っていてもパスが prefix 途中で切れない。
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
    const candidates: Array<{ idx: number; prefixLen: number; expandTilde: boolean }> = [];
    const dirIdx = text.indexOf(dirPrefix, searchStart);
    if (dirIdx !== -1) {
      candidates.push({ idx: dirIdx, prefixLen: dirPrefix.length, expandTilde: false });
    }
    if (homePrefix) {
      const homeIdx = text.indexOf(homePrefix, searchStart);
      if (homeIdx !== -1) {
        candidates.push({ idx: homeIdx, prefixLen: homePrefix.length, expandTilde: false });
      }
      const tildeIdx = text.indexOf("~/", searchStart);
      if (tildeIdx !== -1) {
        candidates.push({ idx: tildeIdx, prefixLen: 2, expandTilde: true });
      }
    }

    if (candidates.length === 0) break;

    // idx 昇順、同 idx なら prefixLen 降順（dir > home > tilde）
    candidates.sort((a, b) => a.idx - b.idx || b.prefixLen - a.prefixLen);
    const { idx, prefixLen, expandTilde } = candidates[0]!;

    const pathEnd = findPathEnd(text, idx + prefixLen);
    const fullPath = expandTilde
      ? `${homeDir}/${text.slice(idx + prefixLen, pathEnd)}`
      : text.slice(idx, pathEnd);

    // パス直後に `:行番号` が続くか
    const lineMatch = LINE_NUMBER_SUFFIX.exec(text.slice(pathEnd));
    const lineNumber = lineMatch ? Number(lineMatch[1]) : undefined;
    const totalEnd = lineMatch ? pathEnd + lineMatch[0].length : pathEnd;

    const selectPath = fullPath.startsWith(dirPrefix) ? fullPath.slice(dirPrefix.length) : fullPath;

    if (selectPath.length > 0) {
      matches.push({ idx, totalEnd, selectPath, lineNumber });
    }

    searchStart = totalEnd;
  }

  return matches;
}
