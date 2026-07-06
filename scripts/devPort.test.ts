// derivePortBase の契約を固定する。dev.ts 本体は top-level で port probe と spawn を
// 実行するため import できない（devPort.ts に純粋部を分離しているのはそのため）。

import { describe, expect, test } from "bun:test";
import { derivePortBase, PORT_BASE, PORT_RANGE, PORT_SWEEP } from "./devPort";

describe("derivePortBase", () => {
  test("同一入力からは常に同じ port を導出する（決定論）", () => {
    expect(derivePortBase("/wt/a")).toBe(derivePortBase("/wt/a"));
  });

  test("異なる worktree は異なる port になりうる（分離の実効性）", () => {
    // hash なので衝突自体は許容されるが、代表ペアで分離が機能することを確認する
    expect(derivePortBase("/wt/a")).not.toBe(derivePortBase("/wt/b"));
  });

  test("probe の最大到達点（base + PORT_SWEEP - 1）まで宣言帯に収まる", () => {
    const bandEnd = PORT_BASE + PORT_RANGE - 1;
    for (let i = 0; i < 1000; i++) {
      const base = derivePortBase(`/wt/${i}`);
      expect(base).toBeGreaterThanOrEqual(PORT_BASE);
      expect(base + PORT_SWEEP - 1).toBeLessThanOrEqual(bandEnd);
    }
  });
});
