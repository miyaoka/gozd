// top layer サーフェスの重ね順ロジックのテスト。この module の分岐は raiseSurface の 2 つの
// ガード (最前面 memo / 開いているか) と hideSurface の memo クリア、および pin の積み直しが
// すべてなので、それぞれを固定する。
//
// memo が腐ると raiseSurface が黙って no-op になり「クリックしても前面に来ない」形で表面化する
// (実装では素の showPopover を呼ぶ経路が混ざるとこれが起きる) ため、ガードの分岐は退行検出の
// 主戦場になる。
//
// pin は呼び出しの**順序**そのものが仕様 (サーフェスを show した後に積み直さないとトーストが
// 沈む) なので、全要素の呼び出しを 1 本の log に集約してラベル付きで突き合わせる。要素ごとに
// 分けて数えると、積み直しをサーフェスの show より前へ動かす退行が検出できない。
import { beforeEach, describe, expect, test } from "bun:test";
import {
  hideSurface,
  pinSurface,
  raiseSurface,
  showSurface,
  unpinSurface,
} from "./topLayerSurface";

/** 全モックが共有する呼び出し列 (`"<label>:<op>"`)。 */
let log: string[];

/** popover DOM の最小モック。`:popover-open` を自前で再現する。 */
function createSurface(label: string) {
  let open = false;
  const el = {
    showPopover() {
      open = true;
      log.push(`${label}:show`);
    },
    hidePopover() {
      open = false;
      log.push(`${label}:hide`);
    },
    matches(selector: string) {
      return selector === ":popover-open" && open;
    },
  };
  return { el: el as unknown as HTMLElement, isOpen: () => open };
}

// module state (最前面 memo / pin 集合) は全テストで共有されるため、各テストは自分が開いた
// サーフェスを閉じ、pin を外した状態から始める。
let a: ReturnType<typeof createSurface>;
let b: ReturnType<typeof createSurface>;

beforeEach(() => {
  log = [];
  a = createSurface("a");
  b = createSurface("b");
});

describe("raiseSurface", () => {
  test("既に最前面なら hide/show しない", () => {
    showSurface(a.el);
    log.length = 0;

    raiseSurface(a.el);

    expect(log).toEqual([]);
    hideSurface(a.el);
  });

  test("別のサーフェスが前に出た後は hide → show で積み直す", () => {
    showSurface(a.el);
    showSurface(b.el);
    log.length = 0;

    raiseSurface(a.el);

    expect(log).toEqual(["a:hide", "a:show"]);
    expect(a.isOpen()).toBe(true);
    hideSurface(a.el);
    hideSurface(b.el);
  });

  test("閉じているサーフェスは no-op (開いていないものを show し直さない)", () => {
    showSurface(b.el);
    log.length = 0;

    raiseSurface(a.el);

    expect(log).toEqual([]);
    expect(a.isOpen()).toBe(false);
    hideSurface(b.el);
  });
});

describe("hideSurface", () => {
  test("最前面を閉じた後、同じサーフェスへの raise は開いていない判定で弾かれる", () => {
    showSurface(a.el);
    hideSurface(a.el);
    log.length = 0;

    raiseSurface(a.el);

    expect(log).toEqual([]);
  });
});

describe("pinSurface", () => {
  test("pin 済みはサーフェスの show / raise の後に積み直される", () => {
    const toast = createSurface("toast");
    showSurface(toast.el); // pin 対象も自前で開いている必要がある
    pinSurface(toast.el);
    log.length = 0;

    // show の後に積み直す (前だとトーストがサーフェスの下に沈む)
    showSurface(a.el);
    expect(log).toEqual(["a:show", "toast:hide", "toast:show"]);

    showSurface(b.el);
    log.length = 0;
    raiseSurface(a.el);
    expect(log).toEqual(["a:hide", "a:show", "toast:hide", "toast:show"]);

    unpinSurface(toast.el);
    hideSurface(toast.el);
    hideSurface(a.el);
    hideSurface(b.el);
  });

  test("閉じている pin 対象は積み直しの対象外", () => {
    const toast = createSurface("toast");
    pinSurface(toast.el);

    showSurface(a.el);

    expect(log).toEqual(["a:show"]);
    unpinSurface(toast.el);
    hideSurface(a.el);
  });

  test("unpin 後は積み直されない", () => {
    const toast = createSurface("toast");
    showSurface(toast.el);
    pinSurface(toast.el);
    unpinSurface(toast.el);
    log.length = 0;

    showSurface(a.el);

    expect(log).toEqual(["a:show"]);
    hideSurface(toast.el);
    hideSurface(a.el);
  });
});
