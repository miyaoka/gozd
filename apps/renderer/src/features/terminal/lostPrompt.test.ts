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
    // message は toast にそのまま描かれ、高さ上限も改行保持も無い。長文・複数行の
    // 指示文を message へ載せると画面を覆い、改行が潰れてコピーしても元に戻らない
    const { calls, notify } = recorder();

    notifyLostPrompt(notify, "1 行目\n2 行目\n3 行目");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cause).toBe("1 行目\n2 行目\n3 行目");
    expect(calls[0]?.message).not.toContain("1 行目");
  });

  test("cause が非 undefined なので詳細パネルと Copy が出る", () => {
    // 詳細パネルの表示条件は cause !== undefined。ここが undefined だと本文を
    // コピーする手段が無くなり、「手で渡し直せる」が成立しない
    const { calls, notify } = recorder();

    notifyLostPrompt(notify, "指示");

    expect(calls[0]?.cause).not.toBeUndefined();
  });

  test("指示文が無い経路では通知しない", () => {
    // picker 経由の作成は prefill だけで prompt を持たない
    const { calls, notify } = recorder();

    notifyLostPrompt(notify, undefined);
    notifyLostPrompt(notify, "");

    expect(calls).toHaveLength(0);
  });
});
