import { describe, expect, test } from "bun:test";
import { gitStatusToFileChanges } from "./useChangesStore";

describe("gitStatusToFileChanges", () => {
  test("rename map にヒットするパスは oldFilePath に旧パスを入れる", () => {
    const changes = gitStatusToFileChanges({ "src/new.ts": "R." }, { "src/new.ts": "src/old.ts" });
    expect(changes).toEqual([{ oldFilePath: "src/old.ts", newFilePath: "src/new.ts", type: "R" }]);
  });

  test("rename map に無いパスは old / new とも同じパスになる", () => {
    const changes = gitStatusToFileChanges({ "a.txt": ".M" }, { "src/new.ts": "src/old.ts" });
    expect(changes).toEqual([{ oldFilePath: "a.txt", newFilePath: "a.txt", type: "M" }]);
  });

  test("rename map が空でも全エントリが素通りする", () => {
    const changes = gitStatusToFileChanges({ "a.txt": "??", "b.txt": "A." }, {});
    expect(changes).toContainEqual({ oldFilePath: "a.txt", newFilePath: "a.txt", type: "U" });
    expect(changes).toContainEqual({ oldFilePath: "b.txt", newFilePath: "b.txt", type: "A" });
  });

  test("rename + 編集 (XY=RM) でも map lookup で旧パスが入る", () => {
    // git mv 後にさらに編集すると worktree 側 M が優先され kind は modified に解決されるが、
    // 旧パス解決は kind 分岐でなく map lookup なので oldFilePath は旧パスになる。
    const changes = gitStatusToFileChanges({ "src/new.ts": "RM" }, { "src/new.ts": "src/old.ts" });
    expect(changes).toEqual([{ oldFilePath: "src/old.ts", newFilePath: "src/new.ts", type: "M" }]);
  });
});
