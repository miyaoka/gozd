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

  test("accept は setResult で束ねた callback を選択 item で呼ぶ", async () => {
    const p = createListPicker<Item>();
    const picked: Item[] = [];
    const g = p.open();
    p.setResult(g, [{ id: 7 }], "", async (item) => {
      picked.push(item);
    });
    await p.accept({ id: 7 });
    expect(picked).toEqual([{ id: 7 }]);
  });

  test("同期 callback が throw しても accept は同期例外を投げず reject に倒す", async () => {
    // 返り値の型は Promise。同期例外にすると呼び出し側が受け取る前に呼び出し元まで飛び、
    // 失敗の届き方が callback の同期 / 非同期で変わる
    const p = createListPicker<Item>();
    const g = p.open();
    p.setResult(g, [{ id: 1 }], "", () => {
      throw new Error("sync boom");
    });

    let returned: Promise<void> | undefined;
    expect(() => {
      returned = p.accept({ id: 1 });
    }).not.toThrow();
    expect(returned).toBeInstanceOf(Promise);
    await expect(returned).rejects.toThrow("sync boom");
  });

  test("throw された値はそのまま reject の理由になる", () => {
    // 捕まえて包み直すと、非 Error の throw だけ理由が差し替わり、同期 / 非同期で
    // 失敗の見え方が変わる
    const p = createListPicker<Item>();
    const g = p.open();
    p.setResult(g, [{ id: 1 }], "", () => {
      throw "文字列を throw";
    });

    return expect(p.accept({ id: 1 })).rejects.toBe("文字列を throw");
  });

  // callback の完了を呼び出し側が待てるための契約（利用は任意）
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

describe("createListPicker のページ送り", () => {
  const noop = () => {};
  const page = (items: Item[], done = false) => ({ items, done });

  /** 1 ページ目まで出した picker と、渡した順にページを返す source を用意する */
  function paged(pages: { items: Item[]; done: boolean }[]) {
    const p = createListPicker<Item>();
    const gen = p.open();
    p.setResult(gen, [{ id: 1 }], "", noop);
    p.setTotalCount(gen, 3);
    let calls = 0;
    p.setPageSource(gen, async () => {
      calls++;
      return pages.shift() ?? page([], true);
    });
    return { p, gen, calls: () => calls };
  }

  test("requestMore は末尾へ足す（並べ替えない）", async () => {
    const { p } = paged([page([{ id: 2 }, { id: 3 }])]);
    await p.requestMore();
    expect(p.items.value.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  test("totalCount は setTotalCount が渡した総数", () => {
    const { p } = paged([]);
    expect(p.totalCount.value).toBe(3);
  });

  // 1 ページで収まった取得でも総数は意味を持つ。「続きがあるか」とは別の問い
  test("続きが無くても totalCount は持てる", () => {
    const p = createListPicker<Item>();
    const gen = p.open();
    p.setResult(gen, [{ id: 1 }], "", noop);
    p.setTotalCount(gen, 1);
    expect(p.totalCount.value).toBe(1);
    expect(p.hasMore.value).toBe(false);
    expect(p.pagedOnce.value).toBe(false);
  });

  // スクロールは 1 回の末尾到達で何度も発火する。判定を呼び出し側に出すと同じページを重複取得する
  test("取得中の再要求は無視する", async () => {
    const { p, calls } = paged([page([{ id: 2 }]), page([{ id: 3 }])]);
    const first = p.requestMore();
    await p.requestMore();
    await first;
    expect(calls()).toBe(1);
  });

  // 最終ページは「項目があり、かつこれで終わり」。done を同時に返せないと二重に足される
  test("項目を持つ最終ページはその場で打ち切る", async () => {
    const { p, calls } = paged([page([{ id: 2 }], true)]);
    await p.requestMore();
    expect(p.items.value.map((i) => i.id)).toEqual([1, 2]);
    expect(p.hasMore.value).toBe(false);
    await p.requestMore();
    expect(calls()).toBe(1);
    expect(p.items.value.map((i) => i.id)).toEqual([1, 2]);
  });

  test("失敗 (items 空 + done) は一覧を保ったまま打ち切る", async () => {
    const { p } = paged([page([], true)]);
    await p.requestMore();
    expect(p.items.value.map((i) => i.id)).toEqual([1]);
    expect(p.hasMore.value).toBe(false);
  });

  // 閉じた後も続きを取ると、結果は捨てられるのに消費だけが残る
  test("閉じた後の requestMore は取りに行かない", async () => {
    const { p, calls } = paged([page([{ id: 2 }])]);
    p.markClosed();
    await p.requestMore();
    expect(calls()).toBe(0);
  });

  // 閉じた通知が「いま表示している dialog のものか」は表示側が判定する契約なので、
  // markClosed 自体は世代を見ない。open() が改めて表示状態にすることだけを固定する
  test("開き直すと閉じた記録が解除される", async () => {
    const { p } = paged([]);
    p.markClosed();
    const gen = p.open();
    p.setResult(gen, [{ id: 1 }], "", noop);
    let calls = 0;
    p.setPageSource(gen, async () => {
      calls++;
      return page([{ id: 2 }]);
    });
    await p.requestMore();
    expect(calls).toBe(1);
  });

  test("hide も取得を止める", async () => {
    const { p, gen, calls } = paged([page([{ id: 2 }])]);
    p.hide(gen);
    await p.requestMore();
    expect(calls()).toBe(0);
  });

  // await 中に開き直された世代の結果は捨てる。捨てないと前の問いの続きが新しい一覧へ混ざる
  test("取得中に開き直すと、届いたページを捨てる", async () => {
    const p = createListPicker<Item>();
    const gen = p.open();
    p.setResult(gen, [{ id: 1 }], "", noop);
    let release: (value: { items: Item[]; done: boolean }) => void = () => {};
    p.setPageSource(gen, () => new Promise((resolve) => (release = resolve)));
    const pending = p.requestMore();
    p.open();
    release(page([{ id: 2 }]));
    await pending;
    expect(p.items.value).toEqual([]);
  });

  test("開き直すとページ送りの状態は消える", async () => {
    const { p, calls } = paged([page([{ id: 2 }])]);
    p.open();
    expect(p.hasMore.value).toBe(false);
    expect(p.totalCount.value).toBe(0);
    expect(p.pagedOnce.value).toBe(false);
    await p.requestMore();
    expect(calls()).toBe(0);
  });

  test("古い世代の setPageSource / setTotalCount は無視される", () => {
    const p = createListPicker<Item>();
    const gen = p.open();
    p.open();
    p.setPageSource(gen, async () => page([], true));
    p.setTotalCount(gen, 3);
    expect(p.hasMore.value).toBe(false);
    expect(p.totalCount.value).toBe(0);
  });
});
