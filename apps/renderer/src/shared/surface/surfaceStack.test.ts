// サーフェスの重ね順・フォーカス追従・pin の判断モデルのテスト。
//
// 固定するのは順序そのもの: pin の積み直しがサーフェスの show より後に来ること、閉じた面が
// フォーカスを持っていたときだけフォーカスが動くこと、既に最前面への持ち上げが操作ゼロで
// 終わること。いずれも「どこで壊れても静かに壊れる」種類の不変条件 (判断を操作列として取り出す
// 理由は surfaceStack.ts の docstring)。
import { describe, expect, test } from "bun:test";
import { planHide, planRaise, planShow } from "./surfaceStack";

const NO_PIN = { pinnedOpen: [] as string[] };

describe("planShow", () => {
  test("show してからフォーカスを入れ、最後に pin を積み直す", () => {
    const plan = planShow(["a"], "b", { pinnedOpen: ["toast"] });

    // pin の hide/show が "b:show" より前に来るとトーストがサーフェスの下に沈む
    expect(plan.ops).toEqual([
      { kind: "show", el: "b" },
      { kind: "focus", el: "b" },
      { kind: "hide", el: "toast" },
      { kind: "show", el: "toast" },
    ]);
    expect(plan.stack).toEqual(["a", "b"]);
  });

  test("既に列にあるサーフェスは重複せず末尾へ移る", () => {
    const plan = planShow(["a", "b"], "a", NO_PIN);

    expect(plan.stack).toEqual(["b", "a"]);
  });
});

describe("planRaise", () => {
  test("既に最前面なら操作なし (無意味な積み直しでフォーカスを落とさない)", () => {
    const plan = planRaise(["a", "b"], "b", { isOpen: true, focusedInside: undefined, ...NO_PIN });

    expect(plan.ops).toEqual([]);
    expect(plan.stack).toEqual(["a", "b"]);
  });

  test("開いていないサーフェスは操作なし", () => {
    const plan = planRaise(["a"], "z", { isOpen: false, focusedInside: undefined, ...NO_PIN });

    expect(plan.ops).toEqual([]);
  });

  test("内側でフォーカスを持っていた要素へ戻す (積み直しで落ちても入力先を保つ)", () => {
    const plan = planRaise(["a", "b"], "a", {
      isOpen: true,
      focusedInside: "a-editor",
      ...NO_PIN,
    });

    expect(plan.ops).toEqual([
      { kind: "hide", el: "a" },
      { kind: "show", el: "a" },
      { kind: "focus", el: "a-editor" },
    ]);
  });

  test("背面なら hide → show で積み直し、フォーカスを入れ、pin を積み直す", () => {
    const plan = planRaise(["a", "b"], "a", {
      isOpen: true,
      focusedInside: undefined,
      pinnedOpen: ["toast"],
    });

    expect(plan.ops).toEqual([
      { kind: "hide", el: "a" },
      { kind: "show", el: "a" },
      { kind: "focus", el: "a" },
      { kind: "hide", el: "toast" },
      { kind: "show", el: "toast" },
    ]);
    expect(plan.stack).toEqual(["b", "a"]);
  });
});

describe("planHide", () => {
  test("フォーカスを持っていれば次の前面へ移す (ESC 連打が手前から順に閉じる根拠)", () => {
    const plan = planHide(["a", "b"], "b", { hadFocus: true });

    expect(plan.ops).toEqual([
      { kind: "hide", el: "b" },
      { kind: "focus", el: "a" },
    ]);
    expect(plan.stack).toEqual(["a"]);
    expect(plan.restoreReturnFocus).toBe(false);
  });

  test("フォーカスを持っていなければ動かさない (ターミナルから引き剥がさない)", () => {
    const plan = planHide(["a", "b"], "b", { hadFocus: false });

    expect(plan.ops).toEqual([{ kind: "hide", el: "b" }]);
  });

  test("最後の 1 枚を閉じたら開く前の位置へ戻す", () => {
    const plan = planHide(["a"], "a", { hadFocus: true });

    expect(plan.ops).toEqual([{ kind: "hide", el: "a" }]);
    expect(plan.restoreReturnFocus).toBe(true);
    expect(plan.clearReturnFocus).toBe(true);
  });

  test("列が空になれば復帰先の控えは捨てる (実際に復帰したかとは独立)", () => {
    const plan = planHide(["a"], "a", { hadFocus: false });

    expect(plan.restoreReturnFocus).toBe(false);
    expect(plan.clearReturnFocus).toBe(true);
  });

  test("列が残るなら控えは保持する", () => {
    expect(planHide(["a", "b"], "b", { hadFocus: true }).clearReturnFocus).toBe(false);
  });
});
