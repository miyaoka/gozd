import { describe, expect, test } from "bun:test";
import {
  LEAF_MIN_HEIGHT,
  LEAF_MIN_WIDTH,
  SPLIT_HANDLE_SIZE,
  collectLeafIds,
  createLeaf,
  findFirstLeaf,
  flattenTree,
  getMinSize,
  removeNode,
  resizeBranch,
  splitNode,
} from "./splitTree";
import type { FlatHandle, FlatLeaf, SplitBranch } from "./splitTree";

describe("createLeaf", () => {
  test("id が文字列で返る", () => {
    const leaf = createLeaf();
    expect(leaf.type).toBe("leaf");
    expect(typeof leaf.id).toBe("string");
    expect(leaf.id.length).toBeGreaterThan(0);
  });

  test("呼び出しごとに異なる id", () => {
    const a = createLeaf();
    const b = createLeaf();
    expect(a.id).not.toBe(b.id);
  });
});

describe("findFirstLeaf", () => {
  test("単一リーフ", () => {
    const leaf = createLeaf();
    expect(findFirstLeaf(leaf)).toBe(leaf.id);
  });

  test("ネストした branch の最左リーフ", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const leaf3 = createLeaf();
    const inner: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };
    const root: SplitBranch = {
      type: "branch",
      id: "b2",
      direction: "vertical",
      ratio: 0.5,
      first: inner,
      second: leaf3,
    };
    expect(findFirstLeaf(root)).toBe(leaf1.id);
  });
});

describe("collectLeafIds", () => {
  test("単一リーフ", () => {
    const leaf = createLeaf();
    expect(collectLeafIds(leaf)).toEqual([leaf.id]);
  });

  test("DFS 順で全リーフを収集", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const leaf3 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };
    const root: SplitBranch = {
      type: "branch",
      id: "b2",
      direction: "vertical",
      ratio: 0.5,
      first: branch,
      second: leaf3,
    };
    expect(collectLeafIds(root)).toEqual([leaf1.id, leaf2.id, leaf3.id]);
  });
});

describe("splitNode", () => {
  test("リーフを横分割すると branch になる", () => {
    const leaf = createLeaf();
    const result = splitNode(leaf, leaf.id, "horizontal");

    expect(result.changed).toBe(true);
    expect(result.root.type).toBe("branch");

    const branch = result.root as SplitBranch;
    expect(branch.direction).toBe("horizontal");
    expect(branch.ratio).toBe(0.5);
    expect(branch.first).toBe(leaf);
    expect(branch.second.type).toBe("leaf");
    expect(result.createdLeafId).toBe(branch.second.id);
    expect(result.nextFocusedLeafId).toBe(branch.second.id);
  });

  test("リーフを縦分割", () => {
    const leaf = createLeaf();
    const result = splitNode(leaf, leaf.id, "vertical");

    expect(result.changed).toBe(true);
    const branch = result.root as SplitBranch;
    expect(branch.direction).toBe("vertical");
  });

  test("存在しない targetId では changed: false", () => {
    const leaf = createLeaf();
    const result = splitNode(leaf, "nonexistent", "horizontal");

    expect(result.changed).toBe(false);
    expect(result.root).toBe(leaf);
  });

  test("深いネストでの分割", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };

    const result = splitNode(branch, leaf2.id, "vertical");
    expect(result.changed).toBe(true);

    const root = result.root as SplitBranch;
    expect(root.first).toBe(leaf1);
    expect(root.second.type).toBe("branch");

    const newBranch = root.second as SplitBranch;
    expect(newBranch.direction).toBe("vertical");
    expect(newBranch.first).toBe(leaf2);
  });

  test("immutable: 元のノードは変更されない", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const original: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };

    splitNode(original, leaf1.id, "vertical");

    expect(original.first).toBe(leaf1);
    expect(original.second).toBe(leaf2);
  });
});

describe("removeNode", () => {
  test("最後の1リーフは削除不可", () => {
    const leaf = createLeaf();
    const result = removeNode(leaf, leaf.id);

    expect(result.changed).toBe(false);
    expect(result.root).toBe(leaf);
    expect(result.nextFocusedLeafId).toBe(leaf.id);
  });

  test("2リーフから first を削除すると second が root に昇格", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };

    const result = removeNode(branch, leaf1.id);
    expect(result.changed).toBe(true);
    expect(result.root).toBe(leaf2);
    expect(result.removedLeafId).toBe(leaf1.id);
    expect(result.nextFocusedLeafId).toBe(leaf2.id);
  });

  test("2リーフから second を削除すると first が root に昇格", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };

    const result = removeNode(branch, leaf2.id);
    expect(result.changed).toBe(true);
    expect(result.root).toBe(leaf1);
    expect(result.nextFocusedLeafId).toBe(leaf1.id);
  });

  test("深いネストでの削除", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const leaf3 = createLeaf();
    const inner: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };
    const root: SplitBranch = {
      type: "branch",
      id: "b2",
      direction: "vertical",
      ratio: 0.5,
      first: inner,
      second: leaf3,
    };

    const result = removeNode(root, leaf1.id);
    expect(result.changed).toBe(true);

    const newRoot = result.root as SplitBranch;
    expect(newRoot.first).toBe(leaf2);
    expect(newRoot.second).toBe(leaf3);
    expect(result.nextFocusedLeafId).toBe(leaf2.id);
  });

  test("存在しない targetId では changed: false", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };

    const result = removeNode(branch, "nonexistent");
    expect(result.changed).toBe(false);
    expect(result.root).toBe(branch);
  });

  test("branch の second 側の深い削除", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const leaf3 = createLeaf();
    const inner: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf2,
      second: leaf3,
    };
    const root: SplitBranch = {
      type: "branch",
      id: "b2",
      direction: "vertical",
      ratio: 0.5,
      first: leaf1,
      second: inner,
    };

    const result = removeNode(root, leaf3.id);
    expect(result.changed).toBe(true);

    const newRoot = result.root as SplitBranch;
    expect(newRoot.first).toBe(leaf1);
    expect(newRoot.second).toBe(leaf2);
  });
});

describe("resizeBranch", () => {
  test("指定 branch の ratio を更新", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };

    const result = resizeBranch(branch, "b1", 0.7) as SplitBranch;
    expect(result.ratio).toBe(0.7);
    expect(result.first).toBe(leaf1);
    expect(result.second).toBe(leaf2);
  });

  test("存在しない branchId では元のノードをそのまま返す", () => {
    const leaf = createLeaf();
    const result = resizeBranch(leaf, "nonexistent", 0.3);
    expect(result).toBe(leaf);
  });

  test("深いネストでの ratio 更新", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const leaf3 = createLeaf();
    const inner: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };
    const root: SplitBranch = {
      type: "branch",
      id: "b2",
      direction: "vertical",
      ratio: 0.5,
      first: inner,
      second: leaf3,
    };

    const result = resizeBranch(root, "b1", 0.3) as SplitBranch;
    expect(result.ratio).toBe(0.5);
    const updatedInner = result.first as SplitBranch;
    expect(updatedInner.ratio).toBe(0.3);
  });

  test("immutable: 他のノードの参照は変わらない", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const leaf3 = createLeaf();
    const inner: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };
    const root: SplitBranch = {
      type: "branch",
      id: "b2",
      direction: "vertical",
      ratio: 0.5,
      first: inner,
      second: leaf3,
    };

    const result = resizeBranch(root, "b1", 0.3) as SplitBranch;
    expect(result.second).toBe(leaf3);
  });
});

describe("getMinSize", () => {
  test("単一リーフの水平最小サイズ", () => {
    const leaf = createLeaf();
    expect(getMinSize(leaf, "horizontal")).toBe(LEAF_MIN_WIDTH);
  });

  test("単一リーフの垂直最小サイズ", () => {
    const leaf = createLeaf();
    expect(getMinSize(leaf, "vertical")).toBe(LEAF_MIN_HEIGHT);
  });

  test("同方向 branch: first + handle + second", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };

    expect(getMinSize(branch, "horizontal")).toBe(
      LEAF_MIN_WIDTH + SPLIT_HANDLE_SIZE + LEAF_MIN_WIDTH,
    );
  });

  test("直交方向 branch: max(first, second)", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };

    expect(getMinSize(branch, "vertical")).toBe(LEAF_MIN_HEIGHT);
  });

  test("ネストした branch の計算", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const leaf3 = createLeaf();
    const inner: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };
    const root: SplitBranch = {
      type: "branch",
      id: "b2",
      direction: "horizontal",
      ratio: 0.5,
      first: inner,
      second: leaf3,
    };

    // inner(120 + 8 + 120) + 8 + leaf3(120) = 376
    expect(getMinSize(root, "horizontal")).toBe(
      LEAF_MIN_WIDTH + SPLIT_HANDLE_SIZE + LEAF_MIN_WIDTH + SPLIT_HANDLE_SIZE + LEAF_MIN_WIDTH,
    );
  });
});

describe("flattenTree", () => {
  const H = SPLIT_HANDLE_SIZE;

  test("単一リーフはコンテナ全体を占める", () => {
    const leaf = createLeaf();
    const result = flattenTree(leaf, 1000, 600);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("leaf");
    const flat = result[0] as FlatLeaf;
    expect(flat.id).toBe(leaf.id);
    expect(flat.rect).toEqual({ top: 0, left: 0, width: 1000, height: 600 });
  });

  test("水平分割: leaf + handle + leaf", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.6,
      first: leaf1,
      second: leaf2,
    };

    const result = flattenTree(branch, 1000, 600);
    expect(result).toHaveLength(3);

    const available = 1000 - H;
    const firstW = available * 0.6;
    const secondW = available * 0.4;

    const l1 = result.find((e) => e.type === "leaf" && e.id === leaf1.id) as FlatLeaf;
    const l2 = result.find((e) => e.type === "leaf" && e.id === leaf2.id) as FlatLeaf;
    const h = result.find((e) => e.type === "handle") as FlatHandle;

    expect(l1.rect).toEqual({ top: 0, left: 0, width: firstW, height: 600 });
    expect(h.rect).toEqual({ top: 0, left: firstW, width: H, height: 600 });
    expect(h.availablePx).toBe(available);
    expect(l2.rect).toEqual({ top: 0, left: firstW + H, width: secondW, height: 600 });
  });

  test("垂直分割: leaf + handle + leaf", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "vertical",
      ratio: 0.3,
      first: leaf1,
      second: leaf2,
    };

    const result = flattenTree(branch, 800, 600);
    const available = 600 - H;
    const firstH = available * 0.3;
    const secondH = available * 0.7;

    const l1 = result.find((e) => e.type === "leaf" && e.id === leaf1.id) as FlatLeaf;
    const l2 = result.find((e) => e.type === "leaf" && e.id === leaf2.id) as FlatLeaf;
    const h = result.find((e) => e.type === "handle") as FlatHandle;

    expect(l1.rect).toEqual({ top: 0, left: 0, width: 800, height: firstH });
    expect(h.rect).toEqual({ top: firstH, left: 0, width: 800, height: H });
    expect(l2.rect).toEqual({ top: firstH + H, left: 0, width: 800, height: secondH });
  });

  test("ネスト: H(V(A, B), C) — 異なる方向の分割でも正しく配置", () => {
    const A = createLeaf();
    const B = createLeaf();
    const C = createLeaf();
    const inner: SplitBranch = {
      type: "branch",
      id: "bV",
      direction: "vertical",
      ratio: 0.5,
      first: A,
      second: B,
    };
    const root: SplitBranch = {
      type: "branch",
      id: "bH",
      direction: "horizontal",
      ratio: 0.5,
      first: inner,
      second: C,
    };

    const result = flattenTree(root, 1000, 600);
    // 3 leaves + 2 handles = 5 elements
    expect(result).toHaveLength(5);

    const hAvail = 1000 - H;
    const leftW = hAvail * 0.5;
    const rightW = hAvail * 0.5;

    const vAvail = 600 - H;
    const topH = vAvail * 0.5;
    const bottomH = vAvail * 0.5;

    const a = result.find((e) => e.type === "leaf" && e.id === A.id) as FlatLeaf;
    const b = result.find((e) => e.type === "leaf" && e.id === B.id) as FlatLeaf;
    const c = result.find((e) => e.type === "leaf" && e.id === C.id) as FlatLeaf;

    expect(a.rect).toEqual({ top: 0, left: 0, width: leftW, height: topH });
    expect(b.rect).toEqual({ top: topH + H, left: 0, width: leftW, height: bottomH });
    expect(c.rect).toEqual({ top: 0, left: leftW + H, width: rightW, height: 600 });
  });

  test("ゼロサイズのコンテナで負の幅/高さにならない", () => {
    const leaf1 = createLeaf();
    const leaf2 = createLeaf();
    const branch: SplitBranch = {
      type: "branch",
      id: "b1",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf1,
      second: leaf2,
    };

    const result = flattenTree(branch, 0, 0);
    for (const el of result) {
      const { rect } = el;
      expect(rect.width).toBeGreaterThanOrEqual(0);
      expect(rect.height).toBeGreaterThanOrEqual(0);
    }
  });
});
