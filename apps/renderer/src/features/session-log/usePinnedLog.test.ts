// usePinnedLog store の純粋ロジック部分のテスト。drag handoff の連続性を支える
// takeHandoff の one-shot セマンティクスと、bringToFront の z 単調増加抑止が対象。
// store は module singleton なので、各テストは自分が pin した log の id にだけ触れる。
import { describe, expect, test } from "bun:test";
import { usePinnedLog, type PinnedLog } from "./usePinnedLog";

function pinInput(): Omit<PinnedLog, "id" | "z"> {
  return {
    kind: "assistant",
    repoName: "gozd",
    repoOwner: "miyaoka",
    title: "session title",
    text: "hello",
    x: 10,
    y: 20,
    width: 300,
    height: 200,
  };
}

/** 直近に pin された log を返す (module singleton のため末尾 = 最新)。 */
function lastLog(): PinnedLog {
  const { logs } = usePinnedLog();
  const log = logs.value.at(-1);
  if (log === undefined) throw new Error("no pinned log");
  return log;
}

describe("takeHandoff", () => {
  test("handoff なしの pin では undefined", () => {
    const { pin, takeHandoff } = usePinnedLog();
    pin(pinInput());
    expect(takeHandoff(lastLog().id)).toBeUndefined();
  });

  test("handoff 付き pin は id 一致で 1 回だけ消費できる", () => {
    const { pin, takeHandoff } = usePinnedLog();
    pin(pinInput(), { pointerId: 7, offsetX: 12, offsetY: 34 });
    const id = lastLog().id;
    expect(takeHandoff(id)).toEqual({ pointerId: 7, offsetX: 12, offsetY: 34 });
    // one-shot: 2 回目は消費済みで undefined
    expect(takeHandoff(id)).toBeUndefined();
  });

  test("id 不一致では消費されず、正しい id で後から取れる", () => {
    const { pin, takeHandoff } = usePinnedLog();
    pin(pinInput(), { pointerId: 1, offsetX: 2, offsetY: 3 });
    const id = lastLog().id;
    expect(takeHandoff(id + 999)).toBeUndefined();
    expect(takeHandoff(id)).toEqual({ pointerId: 1, offsetX: 2, offsetY: 3 });
  });

  test("handoff は最後の pin のものだけ残る", () => {
    const { pin, takeHandoff } = usePinnedLog();
    pin(pinInput(), { pointerId: 1, offsetX: 0, offsetY: 0 });
    const firstId = lastLog().id;
    pin(pinInput(), { pointerId: 2, offsetX: 0, offsetY: 0 });
    const secondId = lastLog().id;
    expect(takeHandoff(firstId)).toBeUndefined();
    expect(takeHandoff(secondId)?.pointerId).toBe(2);
  });
});

describe("bringToFront", () => {
  test("背面の window を最前面化し、既に最前面なら z を増やさない", () => {
    const { pin, bringToFront, logs } = usePinnedLog();
    pin(pinInput());
    const first = lastLog();
    pin(pinInput());
    const second = lastLog();
    expect(second.z).toBeGreaterThan(first.z);

    bringToFront(first.id);
    expect(first.z).toBeGreaterThan(second.z);

    // 既に最前面: no-op (連打で z が単調増加し続けない)
    const zBefore = first.z;
    bringToFront(first.id);
    expect(first.z).toBe(zBefore);

    // 存在しない id: no-op
    bringToFront(-1);
    expect(logs.value.some((l) => l.id === -1)).toBe(false);
  });
});

describe("move / close", () => {
  test("move は位置だけ更新し、close は該当 log を取り除く", () => {
    const { pin, move, close, logs } = usePinnedLog();
    pin(pinInput());
    const log = lastLog();
    move(log.id, 111, 222);
    expect(log.x).toBe(111);
    expect(log.y).toBe(222);
    expect(log.width).toBe(300);

    close(log.id);
    expect(logs.value.some((l) => l.id === log.id)).toBe(false);
  });
});
