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
    const g0 = p.open();
    p.setResult(g0, [{ id: 1 }], "alice", async () => {});
    const before = p.showSignal.value;

    p.open();

    expect(p.status.value).toBe("loading");
    expect(p.items.value).toEqual([]);
    expect(p.viewer.value).toBe("");
    expect(p.showSignal.value).toBe(before + 1);
  });

  test("setResult で ready へ遷移し items/viewer を埋める", () => {
    const p = createListPicker<Item>();
    const g = p.open();
    p.setResult(g, [{ id: 1 }, { id: 2 }], "bob", async () => {});
    expect(p.status.value).toBe("ready");
    expect(p.items.value).toEqual([{ id: 1 }, { id: 2 }]);
    expect(p.viewer.value).toBe("bob");
  });

  // 0 件でも ready に遷移する (empty state を dialog 側で表示するため silent 終了しない)
  test("setResult は空配列でも ready に遷移する", () => {
    const p = createListPicker<Item>();
    const g = p.open();
    p.setResult(g, [], "bob", async () => {});
    expect(p.status.value).toBe("ready");
    expect(p.items.value).toEqual([]);
  });

  test("accept は setResult で束ねた callback を選択 item で呼ぶ", () => {
    const p = createListPicker<Item>();
    const picked: Item[] = [];
    const g = p.open();
    p.setResult(g, [{ id: 7 }], "", async (item) => {
      picked.push(item);
    });
    p.accept({ id: 7 });
    expect(picked).toEqual([{ id: 7 }]);
  });

  // 連続選択 (Shift 選択) で dialog が完了までブロックするための契約
  test("accept は callback の完了を表す promise を返す", async () => {
    const p = createListPicker<Item>();
    let resolveCallback: (() => void) | undefined;
    const g = p.open();
    p.setResult(
      g,
      [{ id: 1 }],
      "",
      () =>
        new Promise<void>((resolve) => {
          resolveCallback = resolve;
        }),
    );
    let settled = false;
    const promise = p.accept({ id: 1 }).then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    resolveCallback?.();
    await promise;
    expect(settled).toBe(true);
  });

  // loading 中は選択できないので callback は未束縛。open は前回の callback も破棄する
  test("open 後・setResult 前の accept は no-op（stale callback を残さず即 resolve）", async () => {
    const p = createListPicker<Item>();
    let called = false;
    const g = p.open();
    p.setResult(g, [{ id: 1 }], "", async () => {
      called = true;
    });
    p.open();
    await p.accept({ id: 1 });
    expect(called).toBe(false);
  });

  // dir 切替を挟んだ stale swap / 重複起動の遅延応答を捨てる
  test("古い世代の setResult は無視される（新しい open が置き換えた後）", () => {
    const p = createListPicker<Item>();
    const g1 = p.open();
    p.open(); // g1 を置き換える
    p.setResult(g1, [{ id: 1 }], "alice", async () => {});
    expect(p.status.value).toBe("loading");
    expect(p.items.value).toEqual([]);
    expect(p.viewer.value).toBe("");
  });

  // 返り値の false で呼び出し側が error toast を抑止する
  test("古い世代の hide は false を返し hideSignal を進めない", () => {
    const p = createListPicker<Item>();
    const g1 = p.open();
    p.open(); // g1 を置き換える
    const before = p.hideSignal.value;
    expect(p.hide(g1)).toBe(false);
    expect(p.hideSignal.value).toBe(before);
  });

  test("現在世代の hide は true を返し hideSignal を進める", () => {
    const p = createListPicker<Item>();
    const g = p.open();
    const before = p.hideSignal.value;
    expect(p.hide(g)).toBe(true);
    expect(p.hideSignal.value).toBe(before + 1);
  });
});
