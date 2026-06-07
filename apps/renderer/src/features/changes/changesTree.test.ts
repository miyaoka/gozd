import type { GitFileChange } from "@gozd/proto";
import { describe, expect, test } from "bun:test";
import { buildChangesTree, flattenChangesTree } from "./changesTree";

function ch(newFilePath: string): GitFileChange {
  return { oldFilePath: newFilePath, newFilePath, type: "M" };
}

/**
 * `buildChangesTree` の責務別 spec。displayPath / error contracts など責務ごとに
 * `describe` を nested で区切ることで、将来 `displaySegments` / `anchorPath` 等の境界
 * テスト追加時に責務単位の grouping が維持できる構造にしている。
 */
describe("buildChangesTree", () => {
  /**
   * `displayPath` は chain 圧縮された folder 行の copy 対象 path として user に直接見える値。
   * 右クリック menu の Copy file path で渡される relPath になるため、chain 圧縮ロジックの
   * 境界条件を踏むテストを用意する。
   */
  describe("displayPath", () => {
    test("圧縮なし: 子に複数 folder があるなら chain しない", () => {
      const tree = buildChangesTree([ch("src/a.ts"), ch("src/b.ts"), ch("docs/c.md")]);
      const docs = tree.find((n) => n.kind === "folder" && n.displaySegments[0] === "docs");
      const src = tree.find((n) => n.kind === "folder" && n.displaySegments[0] === "src");
      if (docs?.kind !== "folder" || src?.kind !== "folder") throw new Error("folder not found");
      expect(docs.displayPath).toBe("docs");
      expect(src.displayPath).toBe("src");
    });

    test("1 段 chain: 単独 folder の chain は最深 path を保持する", () => {
      const tree = buildChangesTree([ch(".github/workflows/ci.yml")]);
      const node = tree[0];
      if (node?.kind !== "folder") throw new Error("folder expected");
      expect(node.displaySegments).toEqual([".github", "workflows"]);
      expect(node.anchorPath).toBe(".github");
      expect(node.displayPath).toBe(".github/workflows");
    });

    test("多段 chain: 深い単独 folder の chain も最深 path を保持する", () => {
      const tree = buildChangesTree([ch("a/b/c/d/file.ts"), ch("a/b/c/d/other.ts")]);
      const node = tree[0];
      if (node?.kind !== "folder") throw new Error("folder expected");
      expect(node.displaySegments).toEqual(["a", "b", "c", "d"]);
      expect(node.anchorPath).toBe("a");
      expect(node.displayPath).toBe("a/b/c/d");
    });

    test("file 混在で chain 中断: file を含む段で chain 圧縮が止まる", () => {
      const tree = buildChangesTree([ch("a/file.ts"), ch("a/b/other.ts")]);
      const node = tree[0];
      if (node?.kind !== "folder") throw new Error("folder expected");
      // a に file (`a/file.ts`) と folder (`b`) があるため chain しない
      expect(node.displaySegments).toEqual(["a"]);
      expect(node.displayPath).toBe("a");
    });

    test("root 直下 folder: 単独 file しか無いなら chain せず folder のみ", () => {
      const tree = buildChangesTree([ch("src/main.ts")]);
      const node = tree[0];
      if (node?.kind !== "folder") throw new Error("folder expected");
      expect(node.displaySegments).toEqual(["src"]);
      expect(node.displayPath).toBe("src");
    });
  });

  /**
   * 不正 path (空 segment / 重複 / 末尾 `/`) は silent 落としを避けて throw する契約。
   * `ChangesPane.vue` 側で `tryCatch` + `notify.error` で受ける経路の trigger なので、
   * 「不正入力で throw する」契約自体をテストで担保する。
   */
  describe("error contracts", () => {
    test("重複 / (`a//b.ts`) は throw", () => {
      expect(() => buildChangesTree([ch("a//b.ts")])).toThrow(/Invalid file path/);
    });

    test("末尾 / (`a/b.ts/`) は throw", () => {
      expect(() => buildChangesTree([ch("a/b.ts/")])).toThrow(/Invalid file path/);
    });

    test("空 path は throw", () => {
      expect(() => buildChangesTree([ch("")])).toThrow(/Invalid file path/);
    });
  });
});

/**
 * `flattenChangesTree` は `useChangesStore.orderedFileChanges` 経由で ChangesSummaryView
 * (View all) の縦並び順を決める。「ChangesPane のツリー描画順と一致する」が PR の意図
 * そのものなので、走査順 (folder 先 + 各群を localeCompare、chain 圧縮内も含む depth-first) を
 * spec として固定する。collapsed 状態は `ChangesTreeNode[]` の構造外なので入力にすら現れず、
 * 走査結果は常に全件展開順になる契約を併せて担保する。
 */
describe("flattenChangesTree", () => {
  function paths(changes: GitFileChange[]): string[] {
    return changes.map((c) => c.newFilePath);
  }

  test("空配列は空配列を返す", () => {
    expect(flattenChangesTree([])).toEqual([]);
  });

  test("root 直下の単独 file はそのまま 1 件", () => {
    const tree = buildChangesTree([ch("README.md")]);
    expect(paths(flattenChangesTree(tree))).toEqual(["README.md"]);
  });

  test("同レベルでは folder が先、各群は localeCompare で昇順", () => {
    const tree = buildChangesTree([
      ch("zfile.ts"),
      ch("afile.ts"),
      ch("src/a.ts"),
      ch("docs/c.md"),
    ]);
    expect(paths(flattenChangesTree(tree))).toEqual([
      "docs/c.md",
      "src/a.ts",
      "afile.ts",
      "zfile.ts",
    ]);
  });

  test("chain 圧縮されたフォルダ配下も同じ depth-first 順", () => {
    const tree = buildChangesTree([
      ch(".github/workflows/release.yml"),
      ch(".github/workflows/ci.yml"),
    ]);
    expect(paths(flattenChangesTree(tree))).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
    ]);
  });

  test("nested folder は depth-first で深い側を先に消化してから兄弟へ", () => {
    const tree = buildChangesTree([
      ch("src/b/inner.ts"),
      ch("src/a.ts"),
      ch("src/c.ts"),
      ch("README.md"),
    ]);
    // src 配下: folder b → file a.ts → file c.ts (folder 先 + 各群 localeCompare)
    // root: folder src → file README.md
    expect(paths(flattenChangesTree(tree))).toEqual([
      "src/b/inner.ts",
      "src/a.ts",
      "src/c.ts",
      "README.md",
    ]);
  });

  test("入力 `ChangesTreeNode[]` 自体に collapsed 情報が無いため、走査は常に全件を返す", () => {
    const tree = buildChangesTree([ch("src/a.ts"), ch("src/sub/b.ts"), ch("docs/c.md")]);
    // ChangesPane で `src` が collapsed されていても tree 構造自体は変わらないため
    // (collapsedFolders は描画状態であって ChangesTreeNode に持たせていない)、
    // flatten 結果は全件・ツリー描画順で固定。
    expect(paths(flattenChangesTree(tree))).toEqual(["docs/c.md", "src/sub/b.ts", "src/a.ts"]);
  });
});
