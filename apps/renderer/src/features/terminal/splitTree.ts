/**
 * ターミナル分割ツリーのデータ構造と操作関数。
 * ghostty の SplitTree を参考にした再帰バイナリツリー。
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
 * ノードの最小サイズ（px）を再帰算出する。
 * - leaf: 該当 axis の最小サイズ定数
 * - branch（同方向）: first + handle + second
 * - branch（直交方向）: max(first, second)
 */
function getMinSize(node: SplitNode, axis: Axis): number {
  if (node.type === "leaf") {
    return axis === "horizontal" ? LEAF_MIN_WIDTH : LEAF_MIN_HEIGHT;
  }

  const firstMin = getMinSize(node.first, axis);
  const secondMin = getMinSize(node.second, axis);

  if (node.direction === axis) {
    return firstMin + SPLIT_HANDLE_SIZE + secondMin;
  }

  return Math.max(firstMin, secondMin);
}

export type { SplitDirection, SplitLeaf, SplitBranch, SplitNode, SplitMutationResult, Axis };
export {
  LEAF_MIN_WIDTH,
  LEAF_MIN_HEIGHT,
  SPLIT_HANDLE_SIZE,
  createLeaf,
  findFirstLeaf,
  collectLeafIds,
  splitNode,
  removeNode,
  resizeBranch,
  getMinSize,
};
