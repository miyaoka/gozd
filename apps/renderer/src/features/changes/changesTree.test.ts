import type { GitFileChange } from "@gozd/proto";
import { describe, expect, test } from "bun:test";
import { buildChangesTree } from "./changesTree";

function ch(newFilePath: string): GitFileChange {
  return { oldFilePath: newFilePath, newFilePath, type: "M" };
}

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
