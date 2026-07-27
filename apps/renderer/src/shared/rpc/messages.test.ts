import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { dispatchMessage, onMessage } from "./messages";

let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  // 隔離時の観察ログを吸ってテスト出力を無音にする (検証対象は配送の継続であって
  // console 出力そのものではない)
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

    expect(consoleSpy).toHaveBeenCalled();
    dispose();
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
