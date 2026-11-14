import { describe, expect, test } from "bun:test";
import { notifyLostPrompt, type ErrorNotifier } from "./lostPrompt";

/** 通知の発火を記録するだけの notifier */
function recorder() {
  const calls: Array<{ message: string; cause: unknown }> = [];
  return {
    calls,
    notify: {
      error: (message: string, cause?: unknown) => {
        calls.push({ message, cause });
      },
    } satisfies ErrorNotifier,
  };
}

describe("notifyLostPrompt", () => {
  test("指示文は message ではなく cause に載る", () => {
    const { calls, notify } = recorder();

    notifyLostPrompt(notify, { prompt: "1 行目\n2 行目\n3 行目" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cause).toBe("1 行目\n2 行目\n3 行目");
    expect(calls[0]?.message).not.toContain("1 行目");
  });

  test("cause が非 undefined なので詳細パネルと Copy が出る", () => {
    const { calls, notify } = recorder();

    notifyLostPrompt(notify, { prompt: "指示" });

    expect(calls[0]?.cause).not.toBeUndefined();
  });

  test("指示文も複製も無い経路では通知しない", () => {
    const { calls, notify } = recorder();

    notifyLostPrompt(notify, undefined);
    notifyLostPrompt(notify, { prompt: "" });
    notifyLostPrompt(notify, { prefill: "https://example.test/pr/1" });

    expect(calls).toHaveLength(0);
  });

  test("複製が失われたら、指示文と一緒に複製元のセッションを出す", () => {
    const { calls, notify } = recorder();

    notifyLostPrompt(notify, { prompt: "指示", forkSessionId: "s-1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cause).toBe("claude --resume s-1 --fork-session\n\n指示");
  });

  test("指示文の無い複製が失われても通知する", () => {
    const { calls, notify } = recorder();

    notifyLostPrompt(notify, { forkSessionId: "s-1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cause).toBe("claude --resume s-1 --fork-session");
  });
});
