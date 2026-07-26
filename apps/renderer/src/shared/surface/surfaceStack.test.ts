// 前面順モデルのテスト。固定するのは「前面化の冪等性」と「閉じた後に前面へ繰り上がるのは誰か」で、
// この 2 つがフォーカス追従 (topLayerSurface) の判断材料そのものになる。
//
// 前面化が冪等でないと、既に前面のサーフェスをクリックするたびに無意味な積み直し (hide → show) が
// 走り、フォーカスが落ちて入り直す。繰り上がりを間違えると、ESC 連打が前面から順に閉じなくなる。
import { describe, expect, test } from "bun:test";
import { front, isFront, without, withFront } from "./surfaceStack";

describe("withFront", () => {
  test("新規は末尾に積む", () => {
    expect(withFront(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  test("既存は取り除いてから積み直す (重複を作らない)", () => {
    expect(withFront(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
  });

  test("既に最前面なら並びは変わらない", () => {
    expect(withFront(["a", "b"], "b")).toEqual(["a", "b"]);
  });

  test("元の配列を破壊しない", () => {
    const stack = ["a", "b"];
    withFront(stack, "a");
    expect(stack).toEqual(["a", "b"]);
  });
});

describe("without", () => {
  test("最前面を外すと直下が繰り上がる (閉じた後のフォーカス先)", () => {
    const next = without(["a", "b", "c"], "c");
    expect(next).toEqual(["a", "b"]);
    expect(front(next)).toBe("b");
  });

  test("背面を外しても最前面は変わらない", () => {
    expect(front(without(["a", "b", "c"], "a"))).toBe("c");
  });

  test("含まれない要素はそのまま", () => {
    expect(without(["a", "b"], "z")).toEqual(["a", "b"]);
  });

  test("最後の 1 枚を外すと空になる (フォーカスの戻し先がサーフェス外になる)", () => {
    const next = without(["a"], "a");
    expect(next).toEqual([]);
    expect(front(next)).toBeUndefined();
  });
});

describe("isFront", () => {
  test("末尾だけが最前面", () => {
    expect(isFront(["a", "b"], "b")).toBe(true);
    expect(isFront(["a", "b"], "a")).toBe(false);
  });

  test("空 / 未登録は最前面でない", () => {
    expect(isFront([], "a")).toBe(false);
    expect(isFront(["a"], "z")).toBe(false);
  });
});
