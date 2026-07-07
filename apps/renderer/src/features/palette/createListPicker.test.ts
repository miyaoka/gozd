import { describe, expect, test } from "bun:test";
import { createListPicker } from "./createListPicker";

interface Item {
  id: number;
}

describe("createListPicker", () => {
  test("初期状態は loading・items 空・viewer 空", () => {
    const p = createListPicker<Item>();
    expect(p.status.value).toBe("loading");
    expect(p.items.value).toEqual([]);
    expect(p.viewer.value).toBe("");
  });

  // fetch 前に開くため、open は loading のまま showSignal だけ進める
  test("open で loading・showSignal++、前回の items/viewer をクリアする", () => {
    const p = createListPicker<Item>();
    p.setResult([{ id: 1 }], "alice", () => {});
    const before = p.showSignal.value;

    p.open();

    expect(p.status.value).toBe("loading");
    expect(p.items.value).toEqual([]);
    expect(p.viewer.value).toBe("");
    expect(p.showSignal.value).toBe(before + 1);
  });

  test("setResult で ready へ遷移し items/viewer を埋める", () => {
    const p = createListPicker<Item>();
    p.open();
    p.setResult([{ id: 1 }, { id: 2 }], "bob", () => {});
    expect(p.status.value).toBe("ready");
    expect(p.items.value).toEqual([{ id: 1 }, { id: 2 }]);
    expect(p.viewer.value).toBe("bob");
  });

  // 0 件でも ready に遷移する (empty state を dialog 側で表示するため silent 終了しない)
  test("setResult は空配列でも ready に遷移する", () => {
    const p = createListPicker<Item>();
    p.open();
    p.setResult([], "bob", () => {});
    expect(p.status.value).toBe("ready");
    expect(p.items.value).toEqual([]);
  });

  test("accept は setResult で束ねた callback を選択 item で呼ぶ", () => {
    const p = createListPicker<Item>();
    const picked: Item[] = [];
    p.setResult([{ id: 7 }], "", (item) => picked.push(item));
    p.accept({ id: 7 });
    expect(picked).toEqual([{ id: 7 }]);
  });

  // loading 中は選択できないので callback は未束縛。open は前回の callback も破棄する
  test("open 後・setResult 前の accept は no-op（stale callback を残さない）", () => {
    const p = createListPicker<Item>();
    let called = false;
    p.setResult([{ id: 1 }], "", () => {
      called = true;
    });
    p.open();
    p.accept({ id: 1 });
    expect(called).toBe(false);
  });

  test("hide は hideSignal を進める", () => {
    const p = createListPicker<Item>();
    const before = p.hideSignal.value;
    p.hide();
    expect(p.hideSignal.value).toBe(before + 1);
  });
});
