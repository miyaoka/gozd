// useUndockedLog store の純粋ロジック部分のテスト。drag handoff の連続性を支える
// takeHandoff の one-shot セマンティクスと、bringToFront の z 単調増加抑止が対象。
// store は module singleton なので、各テストは自分が undock した log の id にだけ触れる。
import { describe, expect, test } from "bun:test";
import { useUndockedLog, type UndockedLog } from "./useUndockedLog";

function undockInput(): Omit<UndockedLog, "id" | "z" | "closeRequested"> {
  return {
    kind: "assistant",
    repoName: "gozd",
    repoOwner: "miyaoka",
    title: "session title",
    text: "hello",
    x: 10,
    y: 20,
    bodyWidth: 300,
    bodyHeight: 200,
  };
}

/** 直近に undock された log を返す (module singleton のため末尾 = 最新)。 */
function lastLog(): UndockedLog {
  const { logs } = useUndockedLog();
  const log = logs.value.at(-1);
  if (log === undefined) throw new Error("no undocked log");
  return log;
}

describe("takeHandoff", () => {
  test("handoff なしの undock では undefined", () => {
    const { undock, takeHandoff } = useUndockedLog();
    undock(undockInput());
    expect(takeHandoff(lastLog().id)).toBeUndefined();
  });

  test("handoff 付き undock は id 一致で 1 回だけ消費できる", () => {
    const { undock, takeHandoff } = useUndockedLog();
    undock(undockInput(), { pointerId: 7, offsetX: 12, offsetY: 34 });
    const id = lastLog().id;
    expect(takeHandoff(id)).toEqual({ pointerId: 7, offsetX: 12, offsetY: 34 });
    // one-shot: 2 回目は消費済みで undefined
    expect(takeHandoff(id)).toBeUndefined();
  });

  test("id 不一致では消費されず、正しい id で後から取れる", () => {
    const { undock, takeHandoff } = useUndockedLog();
    undock(undockInput(), { pointerId: 1, offsetX: 2, offsetY: 3 });
    const id = lastLog().id;
    expect(takeHandoff(id + 999)).toBeUndefined();
    expect(takeHandoff(id)).toEqual({ pointerId: 1, offsetX: 2, offsetY: 3 });
  });

  test("handoff は最後の undock のものだけ残る", () => {
    const { undock, takeHandoff } = useUndockedLog();
    undock(undockInput(), { pointerId: 1, offsetX: 0, offsetY: 0 });
    const firstId = lastLog().id;
    undock(undockInput(), { pointerId: 2, offsetX: 0, offsetY: 0 });
    const secondId = lastLog().id;
    expect(takeHandoff(firstId)).toBeUndefined();
    expect(takeHandoff(secondId)?.pointerId).toBe(2);
  });
});

describe("bringToFront", () => {
  test("背面の window を最前面化し、既に最前面なら z を増やさない", () => {
    const { undock, bringToFront, logs } = useUndockedLog();
    undock(undockInput());
    const first = lastLog();
    undock(undockInput());
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
    const { undock, move, close, logs } = useUndockedLog();
    undock(undockInput());
    const log = lastLog();
    move(log.id, 111, 222);
    expect(log.x).toBe(111);
    expect(log.y).toBe(222);
    expect(log.bodyWidth).toBe(300);

    close(log.id);
    expect(logs.value.some((l) => l.id === log.id)).toBe(false);
  });
});
