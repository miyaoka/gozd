import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  dispatchMessage,
  onMessage,
  setListenerErrorReporter,
  setUndeliveredReporter,
} from "./messages";

let spies: Array<{ mockRestore: () => void }> = [];
/** 注入 reporter が受け取った (type, cause)。リセット後に呼ばれないことの確認にも使う */
let reported: Array<[string, unknown]> = [];
/** 購読者不在の報告先が受け取った type */
let undelivered: string[] = [];

beforeEach(() => {
  reported = [];
  undelivered = [];
  setUndeliveredReporter((type) => {
    undelivered.push(type);
  });
  setListenerErrorReporter((type, cause) => {
    reported.push([type, cause]);
  });
  // floor は注入の有無に関わらず出るので、throw を踏む全テストの出力を吸う
  spies = [spyOn(console, "error").mockImplementation(() => {})];
});

afterEach(() => {
  setListenerErrorReporter(undefined);
  setUndeliveredReporter(undefined);
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

  test("pull で取り直せない type は購読者が居なければ観察ログに残る", () => {
    // 購読が張られる前（renderer の mount 前 / リロード中）に届いた newWorktree。
    // 指示文は push payload にしか無く、落ちると worktree だけが残る
    dispatchMessage("newWorktree", { prompt: "指示", dir: "/wt" });

    expect(undelivered).toEqual(["newWorktree"]);
    const consoleSpy = spies[0] as ReturnType<typeof spyOn<Console, "error">>;
    const [message] = consoleSpy.mock.calls[0] ?? [];
    expect(String(message)).toContain("no listener received type=newWorktree");
  });

  test("購読を全部外した後の配送も購読者不在として残る", () => {
    // Set が空になるだけで Map からは消えないため、undefined 判定だけでは素通しになる
    const dispose = onMessage("newWorktree", () => {});
    dispose();

    dispatchMessage("newWorktree", { prompt: "指示" });

    expect(undelivered).toEqual(["newWorktree"]);
  });

  test("届いた type は購読者不在として報告しない", () => {
    const dispose = onMessage("newWorktree", () => {});

    dispatchMessage("newWorktree", { prompt: "指示" });

    expect(undelivered).toEqual([]);
    dispose();
  });

  test("pull で取り直せる type の購読者不在は記録しない", () => {
    // mount 時の pull で回復する push まで記録すると、renderer 再構築のたびに全 type ぶんの
    // ログが出て、本当に失われた 1 件が埋もれる
    dispatchMessage("gitStatusChange", { dir: "/wt" });
    dispatchMessage("ptyText", { id: 1, text: "x" });
    dispatchMessage("claudeFx", { kind: "done" });

    expect(undelivered).toEqual([]);
    const consoleSpy = spies[0] as ReturnType<typeof spyOn<Console, "error">>;
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  test("購読者不在の報告先が throw しても dispatch は throw しない", () => {
    setUndeliveredReporter(() => {
      throw new Error("reporter boom");
    });

    expect(() => {
      dispatchMessage("newWorktree", { prompt: "指示" });
    }).not.toThrow();

    const consoleSpy = spies[0] as ReturnType<typeof spyOn<Console, "error">>;
    const failure = consoleSpy.mock.calls.find(([message]) =>
      String(message).includes("undelivered reporter failed"),
    );
    expect(failure?.[0]).toContain("type=newWorktree");
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
