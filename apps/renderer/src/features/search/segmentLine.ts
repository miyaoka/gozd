import type { TextSearchMatchRange } from "@gozd/rpc";

/** 行テキストを「マッチ / 非マッチ」の区間に切り分けた結果。連結すると元テキストに戻る。 */
export interface LineSegment {
  text: string;
  isMatch: boolean;
}

/**
 * 行テキストと 0-based 列範囲の配列から、ハイライト描画用のセグメント列を作る。
 * 範囲は rg が昇順・非重複で返す前提（ファイル内順序）。
 */
export function segmentLine(text: string, ranges: TextSearchMatchRange[]): LineSegment[] {
  if (ranges.length === 0) return [{ text, isMatch: false }];

  const segments: LineSegment[] = [];
  let cursor = 0;
  for (const { startColumn, endColumn } of ranges) {
    if (startColumn > cursor) {
      segments.push({ text: text.slice(cursor, startColumn), isMatch: false });
    }
    segments.push({ text: text.slice(startColumn, endColumn), isMatch: true });
    cursor = endColumn;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), isMatch: false });
  }
  return segments;
}
