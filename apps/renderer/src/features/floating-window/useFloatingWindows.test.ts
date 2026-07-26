// createFloatingWindows factory の純粋ロジックのテスト。drag handoff の one-shot セマンティクス、
// promote / demote の child 遷移、および id 不在の観察ログが対象。
//
// 重ね順と「最前面を閉じる」は本 store の関心ではない (shared/surface が持つ) ため、ここには無い。
import { describe, expect, spyOn, test } from "bun:test";
import { createFloatingWindows, type FloatingWindowState } from "./useFloatingWindows";

interface TestPayload {
  label: string;
}

type FloatingWindowStore = ReturnType<typeof createFloatingWindows<TestPayload>>;

function undockInput(): TestPayload & Omit<FloatingWindowState, "id"> {
  return { label: "log", x: 10, y: 20, contentWidth: 300, contentHeight: 200 };
}

/** 直近に undock された window を返す。 */
function lastWindow(store: FloatingWindowStore) {
  const win = store.windows.value.at(-1);
  if (win === undefined) throw new Error("no undocked window");
  return win;
}

/** store を空にする。テスト間で残留 window を持ち越さないため。 */
function closeAll(store: FloatingWindowStore) {
  // id を先に写す (close は windows を filter で作り替えるため、走査中の配列を直接使わない)
  const ids = store.windows.value.map((win) => win.id);
  for (const id of ids) store.close(id);
}

describe("takeHandoff", () => {
  test("handoff なしの undock では undefined", () => {
    const store = createFloatingWindows<TestPayload>("test");
    store.undock(undockInput());
    expect(store.takeHandoff(lastWindow(store).id)).toBeUndefined();
    closeAll(store);
  });

  test("handoff 付き undock は id 一致で 1 回だけ消費できる", () => {
    const store = createFloatingWindows<TestPayload>("test");
    store.undock(undockInput(), { pointerId: 7, offsetX: 12, offsetY: 34 });
    const { id } = lastWindow(store);
    expect(store.takeHandoff(id)).toEqual({ pointerId: 7, offsetX: 12, offsetY: 34 });
    // one-shot: 2 回目は消費済みで undefined
    expect(store.takeHandoff(id)).toBeUndefined();
    closeAll(store);
  });

  test("handoff は最後の undock のものだけ残る (単一スロット)", () => {
    const store = createFloatingWindows<TestPayload>("test");
    store.undock(undockInput(), { pointerId: 1, offsetX: 0, offsetY: 0 });
    const firstId = lastWindow(store).id;
    store.undock(undockInput(), { pointerId: 2, offsetX: 0, offsetY: 0 });
    const secondId = lastWindow(store).id;
    // 先行 undock 宛は後続 undock に上書きされて取れない
    expect(store.takeHandoff(firstId)).toBeUndefined();
    expect(store.takeHandoff(secondId)?.pointerId).toBe(2);
    closeAll(store);
  });

  test("id 不一致では消費されず、正しい id で後から取れる", () => {
    const store = createFloatingWindows<TestPayload>("test");
    store.undock(undockInput(), { pointerId: 1, offsetX: 2, offsetY: 3 });
    const { id } = lastWindow(store);
    expect(store.takeHandoff(id + 999)).toBeUndefined();
    expect(store.takeHandoff(id)).toEqual({ pointerId: 1, offsetX: 2, offsetY: 3 });
    closeAll(store);
  });
});

describe("close", () => {
  test("close は該当 window だけを取り除く", () => {
    const store = createFloatingWindows<TestPayload>("test");
    store.undock(undockInput());
    const firstId = lastWindow(store).id;
    store.undock(undockInput());
    const secondId = lastWindow(store).id;

    store.close(firstId);
    expect(store.windows.value.some((w) => w.id === firstId)).toBe(false);
    expect(store.windows.value.some((w) => w.id === secondId)).toBe(true);
    closeAll(store);
  });
});

describe("promote", () => {
  test("promote は child を書く", () => {
    const store = createFloatingWindows<TestPayload>("test");
    store.undock(undockInput());
    const win = lastWindow(store);

    store.promote(win.id, { screenX: 1, screenY: 2, width: 300, height: 200 });
    expect(win.child).toEqual({ screenX: 1, screenY: 2, width: 300, height: 200 });

    closeAll(store);
  });

  test("demote は child を外す (昇格失敗の引き返し)", () => {
    const store = createFloatingWindows<TestPayload>("test");
    store.undock(undockInput());
    const win = lastWindow(store);
    store.promote(win.id, { screenX: 0, screenY: 0, width: 10, height: 10 });

    store.demote(win.id);
    expect(win.child).toBeUndefined();

    closeAll(store);
  });
});

describe("id 不在の観察ログ", () => {
  // ログは「呼び出し元が消えた id を握っている」ことの唯一の手がかりなので、発火と本文を固定する。
  //
  // - キーの型は factory 返り値からの除外リストで導く。rename ではキーが落ち、新しい id 取り
  //   mutator の追加では必須プロパティが増えて、どちらも型エラーになる (手書きの op 文字列が
  //   関数名から剥がれたまま / 新 op が未テストのまま緑になる経路を閉じる)
  // - id を取らない API を足すときだけ Exclude に 1 語加える意図的な opt-out になる
  // - id 不在の呼び出しが実在 entry を書き換えないことも固定する。fallback (先頭 entry へ倒す等)
  //   を作らない規約の見張りがこのテストの立ち位置。fixture は「昇格済み + 後発」の 2 枚にする —
  //   1 枚では demote の fallback が child 不在で無変化になり検出できない (退行注入で実測)
  // - 比較は toStrictEqual。toEqual は undefined 値のキーの増減を無視するため、
  //   child への undefined 書き込みを取り逃がす (実測)
  // - 縮退ログの spy 作法は cwdTracker.test.ts と同じ (finally で必ず戻す)
  const MISSING_ID = -1;
  type MutatorName = Exclude<keyof FloatingWindowStore, "windows" | "undock" | "takeHandoff">;
  const MUTATORS: Record<MutatorName, (store: FloatingWindowStore) => void> = {
    close: (store) => store.close(MISSING_ID),
    move: (store) => store.move(MISSING_ID, 1, 2),
    promote: (store) =>
      store.promote(MISSING_ID, { screenX: 0, screenY: 0, width: 10, height: 10 }),
    demote: (store) => store.demote(MISSING_ID),
  };

  for (const [op, call] of Object.entries(MUTATORS)) {
    test(`${op} は id 不在を state 変更なしでログする`, () => {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const store = createFloatingWindows<TestPayload>("probe");
        // 昇格済み 1 枚 + 後発 1 枚 (前者は child 有り)
        store.undock(undockInput());
        const promoted = lastWindow(store);
        store.promote(promoted.id, { screenX: 1, screenY: 2, width: 30, height: 40 });
        store.undock(undockInput());
        const before = store.windows.value.map((win) => ({ ...win }));

        call(store);

        expect(errorSpy).toHaveBeenCalledWith(
          `[useFloatingWindows:probe] ${op}: window not found id=${MISSING_ID}`,
        );
        // 成功経路でログが出る退行 (テストは緑のまま出力だけ汚れる) を閉じる
        expect(errorSpy).toHaveBeenCalledTimes(1);
        // 実在 entry は 1 つも変わらない (id 不在の呼び出しが別の window を巻き込まない)
        expect(store.windows.value.map((win) => ({ ...win }))).toStrictEqual(before);
        closeAll(store);
      } finally {
        errorSpy.mockRestore();
      }
    });
  }
});
