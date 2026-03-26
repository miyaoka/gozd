/**
 * ターミナル分割ツリーのデータ構造と操作関数。
 * 再帰バイナリツリーによる分割管理。
 * 全関数は immutable 更新（変更パスだけコピーし新しいツリーを返す）。
 */

type SplitDirection = "horizontal" | "vertical";

interface SplitLeaf {
  type: "leaf";
  id: string;
}

interface SplitBranch {
  type: "branch";
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: SplitNode;
  second: SplitNode;
}

type SplitNode = SplitLeaf | SplitBranch;

interface SplitMutationResult {
  root: SplitNode;
  changed: boolean;
  nextFocusedLeafId: string;
  createdLeafId?: string;
  removedLeafId?: string;
}

/** leaf 最小幅（px）。ドラッグ時のソフト制約 */
const LEAF_MIN_WIDTH = 120;
/** leaf 最小高さ（px）。ドラッグ時のソフト制約 */
const LEAF_MIN_HEIGHT = 80;
/** 分割ハンドルの厚み（px） */
const SPLIT_HANDLE_SIZE = 8;

function createLeaf(): SplitLeaf {
  return { type: "leaf", id: crypto.randomUUID() };
}

/** ツリー内の最左（DFS 先頭）リーフ id を返す */
function findFirstLeaf(node: SplitNode): string {
  if (node.type === "leaf") return node.id;
  return findFirstLeaf(node.first);
}

/** ツリー内の全リーフ id を DFS 順で収集する */
function collectLeafIds(node: SplitNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)];
}

/**
 * 対象リーフを branch に置き換えて分割する。
 * 元のリーフが first、新規リーフが second になる。
 */
function splitNode(
  root: SplitNode,
  targetId: string,
  direction: SplitDirection,
): SplitMutationResult {
  const newLeaf = createLeaf();

  function walk(node: SplitNode): SplitNode | undefined {
    if (node.type === "leaf") {
      if (node.id !== targetId) return undefined;
      const branch: SplitBranch = {
        type: "branch",
        id: crypto.randomUUID(),
        direction,
        ratio: 0.5,
        first: node,
        second: newLeaf,
      };
      return branch;
    }

    const newFirst = walk(node.first);
    if (newFirst !== undefined) {
      return { ...node, first: newFirst };
    }

    const newSecond = walk(node.second);
    if (newSecond !== undefined) {
      return { ...node, second: newSecond };
    }

    return undefined;
  }

  const result = walk(root);
  if (result === undefined) {
    return {
      root,
      changed: false,
      nextFocusedLeafId: findFirstLeaf(root),
    };
  }

  return {
    root: result,
    changed: true,
    nextFocusedLeafId: newLeaf.id,
    createdLeafId: newLeaf.id,
  };
}

/**
 * 対象リーフを削除し、兄弟ノードを親の位置に昇格する。
 * 最後の1リーフは削除不可（changed: false で返す）。
 */
function removeNode(root: SplitNode, targetId: string): SplitMutationResult {
  if (root.type === "leaf") {
    return {
      root,
      changed: false,
      nextFocusedLeafId: root.id,
    };
  }

  /**
   * 対象リーフを含む branch を見つけたら、兄弟ノードを返す。
   * 見つからなければ undefined を返す。
   * 深いネストの場合は、変更パスだけ新しいノードを作る。
   */
  function walk(node: SplitNode): { result: SplitNode; sibling: SplitNode } | undefined {
    if (node.type === "leaf") return undefined;

    // first が対象リーフなら second（兄弟）を昇格
    if (node.first.type === "leaf" && node.first.id === targetId) {
      return { result: node.second, sibling: node.second };
    }

    // second が対象リーフなら first（兄弟）を昇格
    if (node.second.type === "leaf" && node.second.id === targetId) {
      return { result: node.first, sibling: node.first };
    }

    // first 側の子孫を探索
    const firstResult = walk(node.first);
    if (firstResult !== undefined) {
      return {
        result: { ...node, first: firstResult.result },
        sibling: firstResult.sibling,
      };
    }

    // second 側の子孫を探索
    const secondResult = walk(node.second);
    if (secondResult !== undefined) {
      return {
        result: { ...node, second: secondResult.result },
        sibling: secondResult.sibling,
      };
    }

    return undefined;
  }

  const found = walk(root);
  if (found === undefined) {
    return {
      root,
      changed: false,
      nextFocusedLeafId: findFirstLeaf(root),
    };
  }

  return {
    root: found.result,
    changed: true,
    nextFocusedLeafId: findFirstLeaf(found.sibling),
    removedLeafId: targetId,
  };
}

/** 指定 branch の ratio を更新する */
function resizeBranch(root: SplitNode, branchId: string, ratio: number): SplitNode {
  if (root.type === "leaf") return root;

  if (root.id === branchId) {
    return { ...root, ratio };
  }

  const newFirst = resizeBranch(root.first, branchId, ratio);
  if (newFirst !== root.first) {
    return { ...root, first: newFirst };
  }

  const newSecond = resizeBranch(root.second, branchId, ratio);
  if (newSecond !== root.second) {
    return { ...root, second: newSecond };
  }

  return root;
}

type Axis = "horizontal" | "vertical";

/**
 * ノードの最小コンテンツサイズ（px）を再帰算出する。
 * CSS Grid の gap はコンテンツ幅に含まれないため、ハンドル幅は加算しない。
 * - leaf: 該当 axis の最小サイズ定数
 * - branch（同方向）: first + second
 * - branch（直交方向）: max(first, second)
 */
function getMinSize(node: SplitNode, axis: Axis): number {
  if (node.type === "leaf") {
    return axis === "horizontal" ? LEAF_MIN_WIDTH : LEAF_MIN_HEIGHT;
  }

  const firstMin = getMinSize(node.first, axis);
  const secondMin = getMinSize(node.second, axis);

  if (node.direction === axis) {
    return firstMin + secondMin;
  }

  return Math.max(firstMin, secondMin);
}

// --- フラットレンダリング用の型と関数 ---

interface PixelRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface FlatLeaf {
  type: "leaf";
  id: string;
  rect: PixelRect;
}

interface FlatHandle {
  type: "handle";
  branchId: string;
  axis: SplitDirection;
  ratio: number;
  firstNode: SplitNode;
  secondNode: SplitNode;
  /** branch の主軸方向の利用可能サイズ（handle 幅を除いた px） */
  availablePx: number;
  rect: PixelRect;
}

type FlatElement = FlatLeaf | FlatHandle;

/**
 * ツリーを DFS で走査し、全 leaf / handle の絶対位置（px）をフラットに算出する。
 * absolute positioning でフラットレンダリングするためのレイアウト関数。
 */
function flattenTree(root: SplitNode, rootWidth: number, rootHeight: number): FlatElement[] {
  const elements: FlatElement[] = [];

  function walk(node: SplitNode, top: number, left: number, width: number, height: number): void {
    if (node.type === "leaf") {
      elements.push({
        type: "leaf",
        id: node.id,
        rect: { top, left, width: Math.max(0, width), height: Math.max(0, height) },
      });
      return;
    }

    const { direction, ratio, first, second } = node;
    const isH = direction === "horizontal";
    const mainSize = isH ? width : height;
    const availablePx = Math.max(0, mainSize - SPLIT_HANDLE_SIZE);
    const firstSize = availablePx * ratio;
    const secondSize = availablePx * (1 - ratio);

    if (isH) {
      walk(first, top, left, firstSize, height);
      elements.push({
        type: "handle",
        branchId: node.id,
        axis: direction,
        ratio,
        firstNode: first,
        secondNode: second,
        availablePx,
        rect: { top, left: left + firstSize, width: SPLIT_HANDLE_SIZE, height },
      });
      walk(second, top, left + firstSize + SPLIT_HANDLE_SIZE, secondSize, height);
    } else {
      walk(first, top, left, width, firstSize);
      elements.push({
        type: "handle",
        branchId: node.id,
        axis: direction,
        ratio,
        firstNode: first,
        secondNode: second,
        availablePx,
        rect: { top: top + firstSize, left, width, height: SPLIT_HANDLE_SIZE },
      });
      walk(second, top + firstSize + SPLIT_HANDLE_SIZE, left, width, secondSize);
    }
  }

  walk(root, 0, 0, rootWidth, rootHeight);
  return elements;
}

// --- CSS Grid テンプレート生成 ---

/** 浮動小数点の比較・丸め精度。fr 値の整数化にも使用 */
const GRID_PRECISION = 10000;

function roundForGrid(n: number): number {
  return Math.round(n * GRID_PRECISION) / GRID_PRECISION;
}

/**
 * leafId を CSS grid-area 名に変換する。
 * crypto.randomUUID() は数字始まりになるため、CSS custom-ident として
 * 無効にならないようプレフィックスを付与する。
 */
function leafIdToAreaName(leafId: string): string {
  return `t${leafId}`;
}

interface GridTemplate {
  /** CSS grid-template-areas の値 */
  areas: string;
  /** CSS grid-template-columns の値 */
  columns: string;
  /** CSS grid-template-rows の値 */
  rows: string;
}

/**
 * 分割ツリーから CSS Grid テンプレートを生成する。
 * 各 leaf の配置を grid-template-areas で表現し、
 * 分割比率を grid-template-columns / rows の fr 値で反映する。
 * ハンドルは grid に含めず absolute overlay で配置する前提。
 */
function treeToGridTemplate(root: SplitNode): GridTemplate {
  if (root.type === "leaf") {
    const name = leafIdToAreaName(root.id);
    return { areas: `"${name}"`, columns: "1fr", rows: "1fr" };
  }

  // 各 leaf の正規化 rect (0-1) を算出
  interface NormRect {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const leafRects = new Map<string, NormRect>();

  function walk(node: SplitNode, x: number, y: number, w: number, h: number): void {
    if (node.type === "leaf") {
      leafRects.set(node.id, { x, y, w, h });
      return;
    }
    const { direction, ratio, first, second } = node;
    if (direction === "horizontal") {
      const fw = w * ratio;
      walk(first, x, y, fw, h);
      walk(second, x + fw, y, w - fw, h);
    } else {
      const fh = h * ratio;
      walk(first, x, y, w, fh);
      walk(second, x, y + fh, w, h - fh);
    }
  }

  walk(root, 0, 0, 1, 1);

  // x / y の分割点を収集・ソート
  const xSet = new Set<number>();
  const ySet = new Set<number>();
  for (const rect of leafRects.values()) {
    xSet.add(roundForGrid(rect.x));
    xSet.add(roundForGrid(rect.x + rect.w));
    ySet.add(roundForGrid(rect.y));
    ySet.add(roundForGrid(rect.y + rect.h));
  }
  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);

  // トラックサイズ (integer fr)
  const colFr: number[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    colFr.push(Math.round((xs[i + 1] - xs[i]) * GRID_PRECISION));
  }
  const rowFr: number[] = [];
  for (let i = 0; i < ys.length - 1; i++) {
    rowFr.push(Math.round((ys[i + 1] - ys[i]) * GRID_PRECISION));
  }

  // areas マトリクス構築
  const numRows = rowFr.length;
  const numCols = colFr.length;
  const matrix: string[][] = Array.from({ length: numRows }, () =>
    Array.from<string>({ length: numCols }).fill("."),
  );

  for (const [leafId, rect] of leafRects) {
    const name = leafIdToAreaName(leafId);
    const c0 = xs.indexOf(roundForGrid(rect.x));
    const c1 = xs.indexOf(roundForGrid(rect.x + rect.w));
    const r0 = ys.indexOf(roundForGrid(rect.y));
    const r1 = ys.indexOf(roundForGrid(rect.y + rect.h));
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        matrix[r][c] = name;
      }
    }
  }

  return {
    areas: matrix.map((row) => `"${row.join(" ")}"`).join(" "),
    columns: colFr.map((f) => `${f}fr`).join(" "),
    rows: rowFr.map((f) => `${f}fr`).join(" "),
  };
}

/**
 * 複数の leafId を均等タイルで配置する CSS Grid テンプレートを生成する。
 * Claude のみ表示など、ツリー構造によらない均等配置に使う。
 */
function tileGridTemplate(
  leafIds: string[],
  containerWidth: number,
  containerHeight: number,
): GridTemplate {
  if (leafIds.length === 0) {
    return { areas: '"."', columns: "1fr", rows: "1fr" };
  }
  if (leafIds.length === 1) {
    const name = leafIdToAreaName(leafIds[0]);
    return { areas: `"${name}"`, columns: "1fr", rows: "1fr" };
  }

  const { cols, rows } = computeTileLayout(leafIds.length, containerWidth, containerHeight);

  const areaRows: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      cells.push(i < leafIds.length ? leafIdToAreaName(leafIds[i]) : ".");
    }
    areaRows.push(`"${cells.join(" ")}"`);
  }

  return {
    areas: areaRows.join(" "),
    columns: `repeat(${cols}, 1fr)`,
    rows: `repeat(${rows}, 1fr)`,
  };
}

// --- ハンドル位置算出（CSS Grid レイアウトに対応） ---

interface HandlePosition {
  branchId: string;
  axis: SplitDirection;
  ratio: number;
  firstNode: SplitNode;
  secondNode: SplitNode;
  /** branch の主軸方向のコンテナ内サイズ（px） */
  availablePx: number;
  rect: PixelRect;
}

/**
 * 分割ツリーのハンドル位置を算出する。
 * treeToGridTemplate と同じ正規化座標から grid のトラック px 位置を計算し、
 * 各 branch のハンドルを対応する gap の位置に正確に配置する。
 */
function flattenHandles(
  root: SplitNode,
  rootWidth: number,
  rootHeight: number,
  gap: number,
): HandlePosition[] {
  if (root.type === "leaf") return [];

  // --- 正規化 rect 計算（treeToGridTemplate と同じロジック） ---
  interface NormRect {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  const leafRects = new Map<string, NormRect>();

  function walkNorm(node: SplitNode, x: number, y: number, w: number, h: number): void {
    if (node.type === "leaf") {
      leafRects.set(node.id, { x, y, w, h });
      return;
    }
    if (node.direction === "horizontal") {
      const fw = w * node.ratio;
      walkNorm(node.first, x, y, fw, h);
      walkNorm(node.second, x + fw, y, w - fw, h);
    } else {
      const fh = h * node.ratio;
      walkNorm(node.first, x, y, w, fh);
      walkNorm(node.second, x, y + fh, w, h - fh);
    }
  }

  walkNorm(root, 0, 0, 1, 1);

  // --- breakpoints → grid トラックの px 位置 ---
  const xSet = new Set<number>();
  const ySet = new Set<number>();
  for (const rect of leafRects.values()) {
    xSet.add(roundForGrid(rect.x));
    xSet.add(roundForGrid(rect.x + rect.w));
    ySet.add(roundForGrid(rect.y));
    ySet.add(roundForGrid(rect.y + rect.h));
  }
  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);

  const numCols = xs.length - 1;
  const numRows = ys.length - 1;

  const colFr: number[] = [];
  for (let i = 0; i < numCols; i++) colFr.push(roundForGrid(xs[i + 1] - xs[i]));
  const rowFr: number[] = [];
  for (let i = 0; i < numRows; i++) rowFr.push(roundForGrid(ys[i + 1] - ys[i]));

  const totalColFr = colFr.reduce((a, b) => a + b, 0);
  const totalRowFr = rowFr.reduce((a, b) => a + b, 0);

  const availW = rootWidth - Math.max(0, numCols - 1) * gap;
  const availH = rootHeight - Math.max(0, numRows - 1) * gap;

  // 各トラックの開始・終了 px
  const colStart: number[] = [];
  const colEnd: number[] = [];
  let cx = 0;
  for (let i = 0; i < numCols; i++) {
    colStart.push(cx);
    const w = totalColFr > 0 ? (colFr[i] / totalColFr) * availW : 0;
    colEnd.push(cx + w);
    cx += w + gap;
  }

  const rowStart: number[] = [];
  const rowEnd: number[] = [];
  let cy = 0;
  for (let i = 0; i < numRows; i++) {
    rowStart.push(cy);
    const h = totalRowFr > 0 ? (rowFr[i] / totalRowFr) * availH : 0;
    rowEnd.push(cy + h);
    cy += h + gap;
  }

  /** 指定トラック範囲のコンテンツ幅合計（gap 除く） */
  function colContentPx(from: number, to: number): number {
    let sum = 0;
    for (let i = from; i < to; i++) {
      sum += totalColFr > 0 ? (colFr[i] / totalColFr) * availW : 0;
    }
    return sum;
  }

  /** 指定トラック範囲のコンテンツ高さ合計（gap 除く） */
  function rowContentPx(from: number, to: number): number {
    let sum = 0;
    for (let i = from; i < to; i++) {
      sum += totalRowFr > 0 ? (rowFr[i] / totalRowFr) * availH : 0;
    }
    return sum;
  }

  // --- ツリー走査でハンドル生成 ---
  const handles: HandlePosition[] = [];

  function walkTree(node: SplitNode, nx: number, ny: number, nw: number, nh: number): void {
    if (node.type === "leaf") return;

    const { direction, ratio, first, second } = node;

    if (direction === "horizontal") {
      const splitNx = roundForGrid(nx + nw * ratio);
      const splitCol = xs.indexOf(splitNx);
      const startCol = xs.indexOf(roundForGrid(nx));
      const endCol = xs.indexOf(roundForGrid(nx + nw));
      const startRow = ys.indexOf(roundForGrid(ny));
      const endRow = ys.indexOf(roundForGrid(ny + nh));

      // splitCol が startCol と一致する場合はハンドルを配置できない（ratio が極端に小さい）
      if (splitCol <= startCol) return;

      handles.push({
        branchId: node.id,
        axis: direction,
        ratio,
        firstNode: first,
        secondNode: second,
        availablePx: colContentPx(startCol, endCol),
        rect: {
          top: rowStart[startRow],
          left: colEnd[splitCol - 1],
          width: gap,
          height: rowEnd[endRow - 1] - rowStart[startRow],
        },
      });

      walkTree(first, nx, ny, nw * ratio, nh);
      walkTree(second, splitNx, ny, nw * (1 - ratio), nh);
    } else {
      const splitNy = roundForGrid(ny + nh * ratio);
      const splitRow = ys.indexOf(splitNy);
      const startCol = xs.indexOf(roundForGrid(nx));
      const endCol = xs.indexOf(roundForGrid(nx + nw));
      const startRow = ys.indexOf(roundForGrid(ny));
      const endRow = ys.indexOf(roundForGrid(ny + nh));

      if (splitRow <= startRow) return;

      handles.push({
        branchId: node.id,
        axis: direction,
        ratio,
        firstNode: first,
        secondNode: second,
        availablePx: rowContentPx(startRow, endRow),
        rect: {
          top: rowEnd[splitRow - 1],
          left: colStart[startCol],
          width: colEnd[endCol - 1] - colStart[startCol],
          height: gap,
        },
      });

      walkTree(first, nx, ny, nw, nh * ratio);
      walkTree(second, nx, splitNy, nw, nh * (1 - ratio));
    }
  }

  walkTree(root, 0, 0, 1, 1);
  return handles;
}

// --- タイルレイアウト計算 ---

/** タイル間のギャップ（px） */
const TILE_GAP = 8;

/**
 * コンテナサイズとアイテム数からタイルの cols/rows を動的に決定する。
 * コンテナのアスペクト比を考慮し、各タイルがなるべく正方形に近くなるようにする。
 */
function computeTileLayout(
  count: number,
  containerWidth: number,
  containerHeight: number,
): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (containerWidth <= 0 || containerHeight <= 0) return { cols: 1, rows: count };

  const aspect = containerWidth / containerHeight;
  const cols = Math.min(count, Math.max(1, Math.round(Math.sqrt(count * aspect))));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

export type {
  SplitDirection,
  SplitBranch,
  SplitNode,
  Axis,
  PixelRect,
  FlatLeaf,
  FlatHandle,
  HandlePosition,
};
export {
  LEAF_MIN_WIDTH,
  LEAF_MIN_HEIGHT,
  SPLIT_HANDLE_SIZE,
  TILE_GAP,
  createLeaf,
  findFirstLeaf,
  collectLeafIds,
  splitNode,
  removeNode,
  resizeBranch,
  getMinSize,
  flattenTree,
  leafIdToAreaName,
  treeToGridTemplate,
  tileGridTemplate,
  flattenHandles,
};
