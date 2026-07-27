import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { dispatchMessage, onMessage, setListenerErrorReporter } from "./messages";

let spies: Array<{ mockRestore: () => void }> = [];
/** 注入 reporter が受け取った (type, cause)。未注入時の console フォールバックの検証にも使う */
let reported: Array<[string, unknown]> = [];

beforeEach(() => {
  reported = [];
  setListenerErrorReporter((type, cause) => {
    reported.push([type, cause]);
  });
  // 未注入経路 (console フォールバック) を踏むテストの出力を吸う
  spies = [spyOn(console, "error").mockImplementation(() => {})];
});

afterEach(() => {
  setListenerErrorReporter(undefined);
  for (const spy of spies) spy.mockRestore();
});

describe("dispatchToListeners", () => {
  test("throw した listener は後続の配送を止めない", () => {
    const received: string[] = [];
    const disposers = [
      onMessage<string>("test:isolation", () => {
        throw new Error("boom");
      }),
      onMessage<string>("test:isolation", (payload) => {
        received.push(payload);
      }),
    ];

    dispatchMessage("test:isolation", "payload");

    expect(received).toEqual(["payload"]);
    for (const dispose of disposers) dispose();
  });

  test("listener の失敗は注入された reporter に渡る", () => {
    const dispose = onMessage("test:log", () => {
      throw new Error("boom");
    });

    dispatchMessage("test:log", undefined);

    // 隔離した以上、失敗が現れる先は reporter だけになる。type で発生源を絞れること、
    // stack を持つ error オブジェクトが渡ること（文字列化で潰れていないこと）を固定する
    const [type, cause] = reported[0] ?? [];
    expect(type).toBe("test:log");
    expect(cause).toBeInstanceOf(Error);
    dispose();
  });

  test("console の floor は reporter の有無に関わらず出る", () => {
    const consoleSpy = spies[0] as ReturnType<typeof spyOn<Console, "error">>;
    const dispose = onMessage("test:floor", () => {
      throw new Error("boom");
    });

    // reporter 注入済み（beforeEach）でも floor は出る
    dispatchMessage("test:floor", undefined);
    expect(reported).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    // 未注入でも同じ書式で出る
    setListenerErrorReporter(undefined);
    dispatchMessage("test:floor", undefined);
    expect(reported).toHaveLength(1);

    const [message, cause] = consoleSpy.mock.calls[1] ?? [];
    expect(message).toContain("[dispatchToListeners]");
    expect(message).toContain("type=test:floor");
    expect(cause).toBeInstanceOf(Error);
    dispose();
  });

  test("reporter が throw しても後続の配送は止まらない", () => {
    setListenerErrorReporter(() => {
      throw new Error("reporter boom");
    });
    const received: string[] = [];
    const disposers = [
      onMessage<string>("test:reporter-throw", () => {
        throw new Error("listener boom");
      }),
      onMessage<string>("test:reporter-throw", (payload) => {
        received.push(payload);
      }),
    ];

    dispatchMessage("test:reporter-throw", "payload");

    expect(received).toEqual(["payload"]);

    // reporter が死んでいることを知る手段はこのログだけ（floor は元の listener 失敗を
    // 出し続けるので、event-log にだけ何も来ない静かな壊れ方になる）。
    // listener failed と撃ち分けられていることも同時に固定する
    const consoleSpy = spies[0] as ReturnType<typeof spyOn<Console, "error">>;
    const reporterCall = consoleSpy.mock.calls.find(([message]) =>
      String(message).includes("reporter failed"),
    );
    expect(reporterCall?.[0]).toContain("type=test:reporter-throw");
    expect(reporterCall?.[1]).toBeInstanceOf(Error);
    expect((reporterCall?.[1] as Error).message).toBe("reporter boom");
    for (const dispose of disposers) dispose();
  });

  test("同一関数の二重購読は 1 件に畳まれ、1 回の解除で消える", () => {
    let calls = 0;
    const fn = () => {
      calls++;
    };
    const disposeFirst = onMessage("test:dedupe", fn);
    onMessage("test:dedupe", fn);

    dispatchMessage("test:dedupe", undefined);
    expect(calls).toBe(1);

    disposeFirst();
    dispatchMessage("test:dedupe", undefined);
    expect(calls).toBe(1);
  });

  test("dispatch 中に自分の disposer を呼んでも後続を飛ばさない", () => {
    const received: string[] = [];
    // 自分の disposer を dispatch 中に呼ぶ listener（closure から参照するので初期化済み）
    const disposeSelf: () => void = onMessage<string>("test:self-dispose", () => {
      disposeSelf();
    });
    const disposeSecond = onMessage<string>("test:self-dispose", (payload) => {
      received.push(payload);
    });

    dispatchMessage("test:self-dispose", "payload");

    expect(received).toEqual(["payload"]);
    disposeSecond();
  });

  test("購読者が全員 throw しても dispatch 自体は throw しない", () => {
    const disposers = [
      onMessage("test:all-throw", () => {
        throw new Error("a");
      }),
      onMessage("test:all-throw", () => {
        throw new Error("b");
      }),
    ];

    expect(() => {
      dispatchMessage("test:all-throw", undefined);
    }).not.toThrow();

    for (const dispose of disposers) dispose();
  });
});
