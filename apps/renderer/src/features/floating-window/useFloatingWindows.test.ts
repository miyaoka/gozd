// createFloatingWindows factory の純粋ロジックのテスト。drag handoff の one-shot セマンティクス、
// bringToFront の z 単調増加抑止、および「昇格した window は in-app パネルとして数えない」
// (cmd+w の closeFront / floatingWindowVisible の対象から外れる) が対象。
import { describe, expect, test } from "bun:test";
import {
  closeFrontFloatingWindow,
  createFloatingWindows,
  type FloatingWindowState,
  hasFloatingWindow,
} from "./useFloatingWindows";

interface TestPayload {
  label: string;
}

function undockInput(): TestPayload & Omit<FloatingWindowState, "id" | "z" | "closeRequestEpoch"> {
  return { label: "log", x: 10, y: 20, bodyWidth: 300, bodyHeight: 200 };
}

/** 直近に undock された window を返す。 */
function lastWindow(store: ReturnType<typeof createFloatingWindows<TestPayload>>) {
  const win = store.windows.value.at(-1);
  if (win === undefined) throw new Error("no undocked window");
  return win;
}

/**
 * store を空にする。factory instance は module の registry に残り続ける (unregister 経路を
 * 持たない) ため、hasFloatingWindow / closeFrontFloatingWindow を見るテストが前のテストの
 * 残留 window を拾わないよう、各テストは自分が undock した window を必ず片付ける。
 */
function closeAll(store: ReturnType<typeof createFloatingWindows<TestPayload>>) {
  // id を先に写す (close は windows を filter で作り替えるため、走査中の配列を直接使わない)
  const ids = store.windows.value.map((win) => win.id);
  for (const id of ids) store.close(id);
}

describe("takeHandoff", () => {
  test("handoff なしの undock では undefined", () => {
    const store = createFloatingWindows<TestPayload>();
    store.undock(undockInput());
    expect(store.takeHandoff(lastWindow(store).id)).toBeUndefined();
    closeAll(store);
  });

  test("handoff 付き undock は id 一致で 1 回だけ消費できる", () => {
    const store = createFloatingWindows<TestPayload>();
    store.undock(undockInput(), { pointerId: 7, offsetX: 12, offsetY: 34 });
    const { id } = lastWindow(store);
    expect(store.takeHandoff(id)).toEqual({ pointerId: 7, offsetX: 12, offsetY: 34 });
    // one-shot: 2 回目は消費済みで undefined
    expect(store.takeHandoff(id)).toBeUndefined();
    closeAll(store);
  });

  test("id 不一致では消費されず、正しい id で後から取れる", () => {
    const store = createFloatingWindows<TestPayload>();
    store.undock(undockInput(), { pointerId: 1, offsetX: 2, offsetY: 3 });
    const { id } = lastWindow(store);
    expect(store.takeHandoff(id + 999)).toBeUndefined();
    expect(store.takeHandoff(id)).toEqual({ pointerId: 1, offsetX: 2, offsetY: 3 });
    closeAll(store);
  });
});

describe("bringToFront", () => {
  test("最前面でなければ z が上がり、最前面なら据え置く", () => {
    const store = createFloatingWindows<TestPayload>();
    store.undock(undockInput());
    const first = lastWindow(store);
    store.undock(undockInput());
    const second = lastWindow(store);
    expect(second.z).toBeGreaterThan(first.z);

    store.bringToFront(first.id);
    expect(first.z).toBeGreaterThan(second.z);

    // 既に最前面: z を無駄に増やさない
    const z = first.z;
    store.bringToFront(first.id);
    expect(first.z).toBe(z);
    closeAll(store);
  });
});

describe("close", () => {
  test("close は該当 window だけを取り除く", () => {
    const store = createFloatingWindows<TestPayload>();
    store.undock(undockInput());
    const firstId = lastWindow(store).id;
    store.undock(undockInput());
    const secondId = lastWindow(store).id;

    store.close(firstId);
    expect(store.windows.value.some((w) => w.id === firstId)).toBe(false);
    expect(store.windows.value.some((w) => w.id === secondId)).toBe(true);

    // 存在しない id: no-op
    store.close(-1);
    expect(store.windows.value.some((w) => w.id === secondId)).toBe(true);
    closeAll(store);
  });
});

describe("promote", () => {
  test("promote は child を書き、in-app パネルの集計から外れる", () => {
    const store = createFloatingWindows<TestPayload>();
    store.undock(undockInput());
    const win = lastWindow(store);
    expect(hasFloatingWindow.value).toBe(true);

    store.promote(win.id, { screenX: 1, screenY: 2, width: 300, height: 200 });
    expect(win.child).toEqual({ screenX: 1, screenY: 2, width: 300, height: 200 });
    // 昇格済みだけになれば in-app パネルは 0 枚
    expect(hasFloatingWindow.value).toBe(false);
    // closeFront の対象にもならない (OS フォーカス側の childWindow.close が担うため)
    expect(closeFrontFloatingWindow()).toBe(false);

    closeAll(store);
  });

  test("closeFront は昇格していない最前面の 1 枚に close を要求する", () => {
    const store = createFloatingWindows<TestPayload>();
    store.undock(undockInput());
    const front = lastWindow(store);
    store.undock(undockInput());
    const promoted = lastWindow(store);
    store.promote(promoted.id, { screenX: 0, screenY: 0, width: 10, height: 10 });

    expect(closeFrontFloatingWindow()).toBe(true);
    // 即 close ではなく close 要求 epoch の増加 (consumer の close 経路に合流させる)
    expect(front.closeRequestEpoch).toBe(1);
    expect(promoted.closeRequestEpoch).toBe(0);

    closeAll(store);
  });
});
