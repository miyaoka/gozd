import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createFxCoalescer } from "./fxCoalescer";

// bun:test は setTimeout の fake timer を持たないため、spyOn で捕捉して同期発火させる
// (useNotificationStore.test.ts と同じ方式)。clearTimeout が pendingTimers から消すので
// 「解除済み timer は発火しない」も再現される。
const pendingTimers = new Map<number, () => void>();
let fakeTimerId = 0;

/** 演出の窓が閉じるところまで時間を進める */
function closeWindow() {
  const callbacks = [...pendingTimers.values()];
  pendingTimers.clear();
  for (const cb of callbacks) cb();
}

const WINDOW_MS = 700;

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
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("createFxCoalescer", () => {
  test("窓の間に届いた同一 kind の effects は実行しない", () => {
    const coalescer = createFxCoalescer(WINDOW_MS);
    let calls = 0;
    const effects = () => {
      calls++;
    };

    coalescer.run("error", effects);
    coalescer.run("error", effects);
    coalescer.run("error", effects);

    expect(calls).toBe(1);
    expect(coalescer.kind.value).toBe("error");
  });

  test("窓が閉じれば同一 kind でも再び実行する", () => {
    const coalescer = createFxCoalescer(WINDOW_MS);
    let calls = 0;
    const effects = () => {
      calls++;
    };

    coalescer.run("error", effects);
    closeWindow();
    expect(coalescer.kind.value).toBeUndefined();

    coalescer.run("error", effects);
    expect(calls).toBe(2);
  });

  test("優先度が高い kind は窓の途中でも割り込む", () => {
    const coalescer = createFxCoalescer(WINDOW_MS);
    let calls = 0;
    const effects = () => {
      calls++;
    };

    coalescer.run("success", effects);
    coalescer.run("warning", effects);
    coalescer.run("error", effects);

    expect(calls).toBe(3);
    expect(coalescer.kind.value).toBe("error");
  });

  test("優先度が低い kind は割り込めない", () => {
    const coalescer = createFxCoalescer(WINDOW_MS);
    let calls = 0;
    const effects = () => {
      calls++;
    };

    coalescer.run("error", effects);
    coalescer.run("warning", effects);
    coalescer.run("success", effects);

    expect(calls).toBe(1);
    expect(coalescer.kind.value).toBe("error");
  });

  test("kind が交互に来る束は昇順の発火だけに畳まれる", () => {
    const coalescer = createFxCoalescer(WINDOW_MS);
    let calls = 0;
    const effects = () => {
      calls++;
    };

    // done → needs-input → done → needs-input（並列 worktree で最も起きやすい形）
    coalescer.run("success", effects);
    coalescer.run("warning", effects);
    coalescer.run("success", effects);
    coalescer.run("warning", effects);

    expect(calls).toBe(2);
  });

  test("effects が throw しても窓は解放される", () => {
    const coalescer = createFxCoalescer(WINDOW_MS);
    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});
    spies.push(consoleSpy);

    coalescer.run("error", () => {
      throw new Error("boom");
    });

    expect(consoleSpy).toHaveBeenCalled();
    closeWindow();
    expect(coalescer.kind.value).toBeUndefined();

    // latch していれば以降 error は二度と出ない
    let calls = 0;
    coalescer.run("error", () => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  test("dispose すると解放タイマーが残らない", () => {
    const coalescer = createFxCoalescer(WINDOW_MS);
    coalescer.run("error", () => {});
    coalescer.dispose();
    expect(pendingTimers.size).toBe(0);
  });
});
