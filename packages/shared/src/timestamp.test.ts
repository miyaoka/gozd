import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { generateTimestamp } from "./timestamp";

describe("generateTimestamp", () => {
  afterEach(() => {
    setSystemTime();
  });

  // 名前は git worktree dir / branch の一意名。連続作成 (picker の Shift 連続選択) で
  // 同一秒に複数回呼ばれても衝突しないことが契約
  test("同一秒内の連続呼び出しは連番 suffix で一意になる", () => {
    setSystemTime(new Date("2026-07-15T01:49:28"));
    expect(generateTimestamp()).toBe("20260715_014928");
    expect(generateTimestamp()).toBe("20260715_014928_2");
    expect(generateTimestamp()).toBe("20260715_014928_3");
  });

  test("秒が進むと suffix なしの基本形式に戻る", () => {
    setSystemTime(new Date("2026-07-15T01:49:29"));
    expect(generateTimestamp()).toBe("20260715_014929");
    setSystemTime(new Date("2026-07-15T01:49:30"));
    expect(generateTimestamp()).toBe("20260715_014930");
  });
});
