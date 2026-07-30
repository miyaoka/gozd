/**
 * ドラッグ量を両ペインの最小サイズに収める。
 *
 * 両者を同時に満たせない場合（開始時点でどちらかが既に最小を割っている）は 0 を返す。
 * 片側の min を守るために他方の min を破ると、呼び出し元では「掴んだ瞬間に反対側の
 * 上限値へ飛ぶ」挙動になり、ドラッグとして成立しない。
 */
export function clampResizeDelta(
  rawDelta: number,
  sizes: {
    startBeforeSize: number;
    startAfterSize: number;
    beforeMinSize: number;
    afterMinSize: number;
  },
): number {
  /** before を増やせる量（after を最小サイズまで縮められる分） */
  const maxExpand = sizes.startAfterSize - sizes.afterMinSize;
  /** before を減らせる量 */
  const maxShrink = sizes.startBeforeSize - sizes.beforeMinSize;
  if (maxExpand < 0 || maxShrink < 0) return 0;
  return Math.max(-maxShrink, Math.min(maxExpand, rawDelta));
}
