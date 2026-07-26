// top layer サーフェスの重ね順ロジックのテスト。この module の分岐は raiseSurface の 2 つの
// ガード (最前面 memo / 開いているか) と hideSurface の memo クリア、および pin の積み直しが
// すべてなので、それぞれを固定する。
//
// memo が腐ると raiseSurface が黙って no-op になり「クリックしても前面に来ない」形で表面化する
// (実装では素の showPopover を呼ぶ経路が混ざるとこれが起きる) ため、ガードの分岐は退行検出の
// 主戦場になる。
import { beforeEach, describe, expect, test } from "bun:test";
import {
  hideSurface,
  pinSurface,
  raiseSurface,
  showSurface,
  unpinSurface,
} from "./topLayerSurface";

/** popover DOM の最小モック。呼び出し列を記録し、`:popover-open` を自前で再現する。 */
function createSurface() {
  const calls: string[] = [];
  let open = false;
  const el = {
    showPopover() {
      open = true;
      calls.push("show");
    },
    hidePopover() {
      open = false;
      calls.push("hide");
    },
    matches(selector: string) {
      return selector === ":popover-open" && open;
    },
  };
  return { el: el as unknown as HTMLElement, calls, isOpen: () => open };
}

// module state (最前面 memo / pin 集合) は全テストで共有されるため、各テストは自分が開いた
// サーフェスを閉じ、pin を外した状態から始める。
let a: ReturnType<typeof createSurface>;
let b: ReturnType<typeof createSurface>;

beforeEach(() => {
  a = createSurface();
  b = createSurface();
});

describe("raiseSurface", () => {
  test("既に最前面なら hide/show しない", () => {
    showSurface(a.el);
    a.calls.length = 0;

    raiseSurface(a.el);

    expect(a.calls).toEqual([]);
    hideSurface(a.el);
  });

  test("別のサーフェスが前に出た後は hide → show で積み直す", () => {
    showSurface(a.el);
    showSurface(b.el);
    a.calls.length = 0;

    raiseSurface(a.el);

    expect(a.calls).toEqual(["hide", "show"]);
    expect(a.isOpen()).toBe(true);
    hideSurface(a.el);
    hideSurface(b.el);
  });

  test("閉じているサーフェスは no-op (開いていないものを show し直さない)", () => {
    showSurface(b.el);
    a.calls.length = 0;

    raiseSurface(a.el);

    expect(a.calls).toEqual([]);
    expect(a.isOpen()).toBe(false);
    hideSurface(b.el);
  });
});

describe("hideSurface", () => {
  test("最前面を閉じた後、同じサーフェスへの raise は開いていない判定で弾かれる", () => {
    showSurface(a.el);
    hideSurface(a.el);
    a.calls.length = 0;

    raiseSurface(a.el);

    expect(a.calls).toEqual([]);
  });
});

describe("pinSurface", () => {
  test("サーフェスの show / raise のたびに pin 済みを積み直す", () => {
    const toast = createSurface();
    showSurface(toast.el); // pin 対象も自前で開いている必要がある
    pinSurface(toast.el);
    toast.calls.length = 0;

    showSurface(a.el);
    expect(toast.calls).toEqual(["hide", "show"]);

    showSurface(b.el);
    toast.calls.length = 0;
    raiseSurface(a.el);
    expect(toast.calls).toEqual(["hide", "show"]);

    unpinSurface(toast.el);
    hideSurface(toast.el);
    hideSurface(a.el);
    hideSurface(b.el);
  });

  test("閉じている pin 対象は積み直しの対象外", () => {
    const toast = createSurface();
    pinSurface(toast.el);

    showSurface(a.el);

    expect(toast.calls).toEqual([]);
    unpinSurface(toast.el);
    hideSurface(a.el);
  });

  test("unpin 後は積み直されない", () => {
    const toast = createSurface();
    showSurface(toast.el);
    pinSurface(toast.el);
    unpinSurface(toast.el);
    toast.calls.length = 0;

    showSurface(a.el);

    expect(toast.calls).toEqual([]);
    hideSurface(toast.el);
    hideSurface(a.el);
  });
});
