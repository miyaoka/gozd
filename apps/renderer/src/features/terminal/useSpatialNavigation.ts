/**
 * ターミナル leaf 間の矩形ベース空間ナビゲーション。
 * active dir の visible leaf の DOMRect を取得し、方向に応じて最適な候補を選択する。
 */

type Direction = "left" | "right" | "up" | "down";

interface LeafRect {
  leafId: string;
  rect: DOMRect;
}

/** active dir の visible leaf の DOMRect を収集する。v-show で非表示の leaf は除外する */
function collectLeafRects(container: Element): LeafRect[] {
  const elements = container.querySelectorAll<HTMLElement>("[data-leaf-id]");
  const results: LeafRect[] = [];
  for (const el of elements) {
    const leafId = el.dataset.leafId;
    if (leafId === undefined) continue;
    // v-show="false" の要素は offsetParent が null になる
    if (el.offsetParent === null) continue;
    results.push({ leafId, rect: el.getBoundingClientRect() });
  }
  return results;
}

/** 二つの区間 [a1, a2] と [b1, b2] の重なり量を返す */
function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/** 二つの区間の中心間距離を返す */
function centerDistance(a1: number, a2: number, b1: number, b2: number): number {
  return Math.abs((a1 + a2) / 2 - (b1 + b2) / 2);
}

/**
 * 指定方向で最適な移動先 leaf を見つける。
 * - 方向に沿って候補をフィルタ
 * - cross-axis の重なり量が最大の候補を優先
 * - 同率なら main-axis の距離が最小
 */
export function findNavigationTarget(
  currentLeafId: string,
  direction: Direction,
  container: Element,
): string | undefined {
  const leafRects = collectLeafRects(container);
  const current = leafRects.find((lr) => lr.leafId === currentLeafId);
  if (current === undefined) return undefined;

  const cr = current.rect;

  /** 方向に応じて候補をフィルタし、main-axis / cross-axis を決める */
  const candidates: Array<{ leafId: string; overlapAmount: number; distance: number }> = [];

  for (const lr of leafRects) {
    if (lr.leafId === currentLeafId) continue;
    const tr = lr.rect;

    let isCandidate = false;
    let overlapAmount = 0;
    let distance = 0;

    if (direction === "right") {
      isCandidate = tr.left >= cr.right - 1;
      overlapAmount = overlap(cr.top, cr.bottom, tr.top, tr.bottom);
      distance = centerDistance(cr.left, cr.right, tr.left, tr.right);
    }
    if (direction === "left") {
      isCandidate = tr.right <= cr.left + 1;
      overlapAmount = overlap(cr.top, cr.bottom, tr.top, tr.bottom);
      distance = centerDistance(cr.left, cr.right, tr.left, tr.right);
    }
    if (direction === "down") {
      isCandidate = tr.top >= cr.bottom - 1;
      overlapAmount = overlap(cr.left, cr.right, tr.left, tr.right);
      distance = centerDistance(cr.top, cr.bottom, tr.top, tr.bottom);
    }
    if (direction === "up") {
      isCandidate = tr.bottom <= cr.top + 1;
      overlapAmount = overlap(cr.left, cr.right, tr.left, tr.right);
      distance = centerDistance(cr.top, cr.bottom, tr.top, tr.bottom);
    }

    if (isCandidate) {
      candidates.push({ leafId: lr.leafId, overlapAmount, distance });
    }
  }

  if (candidates.length === 0) return undefined;

  // 重なり量最大 → 距離最小 の順でソート
  candidates.sort((a, b) => {
    if (a.overlapAmount !== b.overlapAmount) return b.overlapAmount - a.overlapAmount;
    return a.distance - b.distance;
  });

  return candidates[0].leafId;
}
