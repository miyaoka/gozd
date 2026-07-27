import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { dispatchMessage, onMessage } from "./messages";

let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  // 隔離時の観察ログを吸ってテスト出力を無音にする。ログ自体が契約である
  // "listener の失敗は観察ログに残す" では発火内容まで assert する
  spies = [spyOn(console, "error").mockImplementation(() => {})];
});

afterEach(() => {
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

  test("listener の失敗は観察ログに残す", () => {
    const consoleSpy = spies[0] as ReturnType<typeof spyOn<Console, "error">>;
    const dispose = onMessage("test:log", () => {
      throw new Error("boom");
    });

    dispatchMessage("test:log", undefined);

    // 隔離した以上、失敗が現れる先はこのログだけになる。type で発生源を絞れること、
    // stack を持つ error オブジェクトが渡ること（文字列補間で潰れていないこと）を固定する
    const [message, cause] = consoleSpy.mock.calls[0] ?? [];
    expect(message).toContain("[dispatchToListeners]");
    expect(message).toContain("type=test:log");
    expect(cause).toBeInstanceOf(Error);
    dispose();
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
