interface RelativePathMatch {
  path: string;
  startIdx: number;
  endIdx: number;
  /** `:行番号` が付与されていた場合の行番号（1-based） */
  lineNumber?: number;
}

/**
 * テキストから相対パスの候補を検出する。
 * ワード文字で始まり、`/` 区切りで2セグメント以上あり、最後のセグメントにファイル拡張子を持つパターン。
 * 複数ドットの拡張子（`.test.ts`, `.d.ts` 等）にも対応する。
 * パスの直後に `:行番号` が続く場合は行番号も抽出する。
 */
export function findRelativePaths(text: string): RelativePathMatch[] {
  const regex = /([\w@.-]+(?:\/[\w@.-]+)*\/[\w@-]+(?:\.[\w]+)+)(?::(\d+))?/g;
  const results: RelativePathMatch[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const startIdx = match.index;
    const lineNumberStr = match[2];
    results.push({
      path: match[1]!,
      startIdx,
      endIdx: startIdx + match[0]!.length,
      ...(lineNumberStr !== undefined ? { lineNumber: Number(lineNumberStr) } : {}),
    });
  }

  return results;
}
