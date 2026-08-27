import { describe, expect, test } from "bun:test";
import { consumeAutostartHint, notifyLostPrompt, type ErrorNotifier } from "./lostPrompt";

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

    notifyLostPrompt(notify, "1 行目\n2 行目\n3 行目");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cause).toBe("1 行目\n2 行目\n3 行目");
    expect(calls[0]?.message).not.toContain("1 行目");
  });

  test("cause が非 undefined なので詳細パネルと Copy が出る", () => {
    const { calls, notify } = recorder();

    notifyLostPrompt(notify, "指示");

    expect(calls[0]?.cause).not.toBeUndefined();
  });

  test("指示文が無い経路では通知しない", () => {
    const { calls, notify } = recorder();

    notifyLostPrompt(notify, undefined);
    notifyLostPrompt(notify, "");

    expect(calls).toHaveLength(0);
  });
});

describe("consumeAutostartHint", () => {
  test("読み取ると同時に消える", () => {
    const hints: Record<string, { prompt?: string }> = { leaf: { prompt: "指示" } };

    expect(consumeAutostartHint(hints, "leaf")?.prompt).toBe("指示");
    expect(hints.leaf).toBeUndefined();
  });

  test("ヒントの無い leaf では undefined を返す", () => {
    const hints: Record<string, { prompt?: string }> = {};

    expect(consumeAutostartHint(hints, "leaf")).toBeUndefined();
  });

  test("他の leaf のヒントは消さない", () => {
    const hints: Record<string, { prompt?: string }> = { a: { prompt: "A" }, b: { prompt: "B" } };

    consumeAutostartHint(hints, "a");

    expect(hints.b?.prompt).toBe("B");
  });
});
