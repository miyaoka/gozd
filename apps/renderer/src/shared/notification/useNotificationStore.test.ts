import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { useNotificationStore } from "./useNotificationStore";

const store = useNotificationStore();

// bun:test は setTimeout の fake timer を持たないため、spyOn で捕捉して同期発火させる。
// clearTimeout が pendingTimers から消すので、「解除済み timer は発火しない」も再現される。
const pendingTimers = new Map<number, () => void>();
let fakeTimerId = 0;

function fireAllTimers() {
  const callbacks = [...pendingTimers.values()];
  pendingTimers.clear();
  for (const cb of callbacks) cb();
}

let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  pendingTimers.clear();
  fakeTimerId = 0;
  spies = [
    spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      pendingTimers.set(++fakeTimerId, cb);
      return fakeTimerId as unknown as ReturnType<typeof setTimeout>;
    }) as never),
    spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
      pendingTimers.delete(id);
    }) as never),
  ];
  // add() の console 出力はテストログに残る (store が module load 時に console.* を
  // CONSOLE_BY_TYPE へ束縛するため後付け spy では黙らせられない)。観察ログなので許容する
  store.clear();
});

afterEach(() => {
  store.clear();
  for (const spy of spies) spy.mockRestore();
});

describe("auto-dismiss", () => {
  test("非 persist の info は時間経過で toast が畳まれ、center には残る", () => {
    store.info("copied");
    expect(store.toasts.value).toHaveLength(1);

    fireAllTimers();
    expect(store.toasts.value).toHaveLength(0);
    expect(store.notifications.value).toHaveLength(1);
    expect(store.notifications.value[0]?.toastVisible).toBe(false);
  });

  test("persist 指定の info は timer が張られず時間経過後も toast が残る", () => {
    store.info("fetch failed", undefined, { persist: true });
    expect(pendingTimers.size).toBe(0);

    fireAllTimers();
    expect(store.toasts.value).toHaveLength(1);
  });

  test("error は opt-in なしで常に persist", () => {
    store.error("boom");
    expect(pendingTimers.size).toBe(0);

    fireAllTimers();
    expect(store.toasts.value).toHaveLength(1);
  });
});

describe("重複抑制と persist 昇格", () => {
  test("表示中の非 persist toast への persist 要求は timer を解除して永続へ昇格する", () => {
    store.info("fetch failed");
    expect(pendingTimers.size).toBe(1);

    store.info("fetch failed", undefined, { persist: true });
    expect(pendingTimers.size).toBe(0);

    fireAllTimers();
    expect(store.toasts.value).toHaveLength(1);
    expect(store.notifications.value[0]?.count).toBe(2);
  });

  test("persist 済み項目への非 persist 要求では降格しない", () => {
    store.info("fetch failed", undefined, { persist: true });
    store.info("fetch failed");
    expect(pendingTimers.size).toBe(0);

    fireAllTimers();
    expect(store.toasts.value).toHaveLength(1);
  });

  test("再発生は toast を出し直し count / seq を進める", () => {
    store.info("copied");
    fireAllTimers();
    expect(store.toasts.value).toHaveLength(0);
    const firstSeq = store.notifications.value[0]?.seq;

    store.info("copied");
    expect(store.toasts.value).toHaveLength(1);
    expect(store.notifications.value).toHaveLength(1);
    expect(store.notifications.value[0]?.count).toBe(2);
    expect(store.notifications.value[0]?.seq).toBeGreaterThan(firstSeq ?? Infinity);
  });

  test("非 persist の再発生は timer を張り直す", () => {
    store.info("copied");
    store.info("copied");
    expect(pendingTimers.size).toBe(1);

    fireAllTimers();
    expect(store.toasts.value).toHaveLength(0);
  });
});

describe("center 操作", () => {
  test("dismiss は toast だけ畳み、remove は項目ごと削除する", () => {
    store.info("a", undefined, { persist: true });
    store.info("b", undefined, { persist: true });
    const [first, second] = store.notifications.value;

    store.dismiss(first!.id);
    expect(store.toasts.value).toHaveLength(1);
    expect(store.notifications.value).toHaveLength(2);

    store.remove(second!.id);
    expect(store.notifications.value).toHaveLength(1);
    expect(store.notifications.value[0]?.id).toBe(first!.id);
  });

  test("clear は全項目を削除し pending timer も解放する", () => {
    store.info("a");
    store.info("b");
    expect(pendingTimers.size).toBe(2);

    store.clear();
    expect(store.notifications.value).toHaveLength(0);
    expect(pendingTimers.size).toBe(0);
  });
});
