// createChildWindows factory の純粋ロジックのテスト。drag handoff の連続性を支える
// takeHandoff の one-shot セマンティクスと close が対象。
import { describe, expect, test } from "bun:test";
import { type ChildWindowInit, createChildWindows } from "./useChildWindows";

interface TestPayload {
  label: string;
}

function undockInput(): TestPayload & ChildWindowInit {
  return { label: "log", screenX: 10, screenY: 20, width: 300, height: 200 };
}

/** 直近に undock された window の id を返す。 */
function lastId(store: ReturnType<typeof createChildWindows<TestPayload>>): number {
  const win = store.windows.value.at(-1);
  if (win === undefined) throw new Error("no undocked window");
  return win.id;
}

describe("takeHandoff", () => {
  test("handoff なしの undock では undefined", () => {
    const store = createChildWindows<TestPayload>();
    store.undock(undockInput());
    expect(store.takeHandoff(lastId(store))).toBeUndefined();
  });

  test("handoff 付き undock は id 一致で 1 回だけ消費できる", () => {
    const store = createChildWindows<TestPayload>();
    store.undock(undockInput(), { pointerId: 7, offsetX: 12, offsetY: 34 });
    const id = lastId(store);
    expect(store.takeHandoff(id)).toEqual({ pointerId: 7, offsetX: 12, offsetY: 34 });
    // one-shot: 2 回目は消費済みで undefined
    expect(store.takeHandoff(id)).toBeUndefined();
  });

  test("id 不一致では消費されず、正しい id で後から取れる", () => {
    const store = createChildWindows<TestPayload>();
    store.undock(undockInput(), { pointerId: 1, offsetX: 2, offsetY: 3 });
    const id = lastId(store);
    expect(store.takeHandoff(id + 999)).toBeUndefined();
    expect(store.takeHandoff(id)).toEqual({ pointerId: 1, offsetX: 2, offsetY: 3 });
  });

  test("handoff は最後の undock のものだけ残る", () => {
    const store = createChildWindows<TestPayload>();
    store.undock(undockInput(), { pointerId: 1, offsetX: 0, offsetY: 0 });
    const firstId = lastId(store);
    store.undock(undockInput(), { pointerId: 2, offsetX: 0, offsetY: 0 });
    const secondId = lastId(store);
    expect(store.takeHandoff(firstId)).toBeUndefined();
    expect(store.takeHandoff(secondId)?.pointerId).toBe(2);
  });
});

describe("close", () => {
  test("close は該当 window だけを取り除く", () => {
    const store = createChildWindows<TestPayload>();
    store.undock(undockInput());
    const firstId = lastId(store);
    store.undock(undockInput());
    const secondId = lastId(store);

    store.close(firstId);
    expect(store.windows.value.some((w) => w.id === firstId)).toBe(false);
    expect(store.windows.value.some((w) => w.id === secondId)).toBe(true);

    // 存在しない id: no-op
    store.close(-1);
    expect(store.windows.value.some((w) => w.id === secondId)).toBe(true);
  });
});
