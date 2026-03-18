interface RelativePathMatch {
  path: string;
  startIdx: number;
  endIdx: number;
}

/**
 * テキストから相対パスの候補を検出する。
 * ワード文字で始まり、`/` 区切りで2セグメント以上あり、最後のセグメントにファイル拡張子を持つパターン。
 * 複数ドットの拡張子（`.test.ts`, `.d.ts` 等）にも対応する。
 */
export function findRelativePaths(text: string): RelativePathMatch[] {
  const regex = /[\w@.-]+(?:\/[\w@.-]+)*\/[\w@-]+(?:\.[\w]+)+/g;
  const results: RelativePathMatch[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const startIdx = match.index;
    results.push({
      path: match[0]!,
      startIdx,
      endIdx: startIdx + match[0]!.length,
    });
  }

  return results;
}
