import { describe, expect, test } from "bun:test";
import { runSerializedSync, type SerializeState } from "./runSerializedSync";

/**
 * production 側の `useFsWatchSync` は `runOneSyncPass` 固定の単一 pass を毎呼び出しで
 * 渡す前提なので、テストでも 1 つの `sharedPass` を使い回す。pass 内で stage を進めて
 * 「何回目の pass か」を観測する。
 */

describe("runSerializedSync", () => {
  test("単発呼び出しは pass を 1 回だけ実行する", async () => {
    const state: SerializeState = { running: false, pending: false };
    let count = 0;
    const pass = async () => {
      count++;
    };
    await runSerializedSync(state, pass);
    expect(count).toBe(1);
    expect(state.running).toBe(false);
    expect(state.pending).toBe(false);
  });

  test("in-flight 中の追加呼び出しは即 return して pending だけ立て、完了後に追加 1 pass が走る", async () => {
    const state: SerializeState = { running: false, pending: false };
    let resolveFirst!: () => void;
    let count = 0;
    const pass = async () => {
      count++;
      if (count === 1) {
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
      }
    };

    const firstCall = runSerializedSync(state, pass);
    // microtask 1 つ進めて pass 1 が await まで進んだ状態にする
    await Promise.resolve();
    expect(state.running).toBe(true);
    expect(state.pending).toBe(false);
    expect(count).toBe(1);

    const secondCall = runSerializedSync(state, pass);
    expect(state.pending).toBe(true);
    expect(count).toBe(1); // pass 2 はまだ走っていない

    resolveFirst();
    await firstCall;
    await secondCall;

    // pass 1 完了後、pending を消化して pass 2 が 1 回走る
    expect(count).toBe(2);
    expect(state.running).toBe(false);
    expect(state.pending).toBe(false);
  });

  test("in-flight 中の複数呼び出しは 1 回の追加 pass に coalesce される", async () => {
    // ccfe6c7 で見落としたレースの核心テスト: 並列に N 個発射しても追加 pass は 1 回。
    const state: SerializeState = { running: false, pending: false };
    let resolveFirst!: () => void;
    let count = 0;
    const pass = async () => {
      count++;
      if (count === 1) {
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
      }
    };

    const first = runSerializedSync(state, pass);
    await Promise.resolve();
    const second = runSerializedSync(state, pass);
    const third = runSerializedSync(state, pass);
    const fourth = runSerializedSync(state, pass);

    expect(count).toBe(1);
    expect(state.pending).toBe(true);

    resolveFirst();
    await Promise.all([first, second, third, fourth]);

    // pass 1 + coalesced pass = 2 回。second/third/fourth は同じ追加 pass で消化される
    expect(count).toBe(2);
    expect(state.running).toBe(false);
  });

  test("coalesced pass が走っている間にさらに発射すると、もう 1 回 pass が走る", async () => {
    // pass 2 完了寸前にも変化が来た場合、do-while ループで pass 3 も消化されることを担保。
    const state: SerializeState = { running: false, pending: false };
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    let count = 0;
    const pass = async () => {
      count++;
      if (count === 1) {
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
      } else if (count === 2) {
        await new Promise<void>((r) => {
          resolveSecond = r;
        });
      }
    };

    const first = runSerializedSync(state, pass);
    await Promise.resolve();
    // pass 1 中に発射 → pass 2 を予約
    const second = runSerializedSync(state, pass);
    resolveFirst();
    // pass 2 が始まるまで microtask を進める
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // pass 2 中にさらに発射 → pass 3 を予約
    const third = runSerializedSync(state, pass);
    resolveSecond();

    await Promise.all([first, second, third]);

    expect(count).toBeGreaterThanOrEqual(2);
    expect(state.running).toBe(false);
    expect(state.pending).toBe(false);
  });

  test("完了後の新規発射は fresh で pass 1 を実行する", async () => {
    const state: SerializeState = { running: false, pending: false };
    let count = 0;
    const pass = async () => {
      count++;
    };
    await runSerializedSync(state, pass);
    await runSerializedSync(state, pass);
    expect(count).toBe(2);
    expect(state.running).toBe(false);
  });

  test("pass が throw した後も running フラグが false に戻る", async () => {
    const state: SerializeState = { running: false, pending: false };
    await expect(
      runSerializedSync(state, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(state.running).toBe(false);
    expect(state.pending).toBe(false);
  });
});
