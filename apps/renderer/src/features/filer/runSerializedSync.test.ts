import { describe, expect, test } from "bun:test";
import { runSerializedSync, type SerializeState, whenIdle } from "./runSerializedSync";

/**
 * production 側の `useFsWatchSync` は `runOneSyncPass` 固定の単一 pass を毎呼び出しで
 * 渡す前提なので、テストでも 1 つの `sharedPass` を使い回す。pass 内で stage を進めて
 * 「何回目の pass か」を観測する。
 */

describe("runSerializedSync", () => {
  test("単発呼び出しは pass を 1 回だけ実行する", async () => {
    const state: SerializeState = { running: false, pending: false, currentRun: null };
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
    const state: SerializeState = { running: false, pending: false, currentRun: null };
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
    const state: SerializeState = { running: false, pending: false, currentRun: null };
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
    // pass 2 完了寸前にも変化が来た場合、do-while ループで pass 3 も消化されることを
    // 厳密に担保する。`toBeGreaterThanOrEqual(2)` だと pass 3 が走らなくても通るため、
    // `toBe(3)` で pass 3 の実行を assertion する。timing 依存を消すため、pass 2 が
    // await に入った瞬間（resolves[1] が代入されたタイミング）で third を発射する。
    const state: SerializeState = { running: false, pending: false, currentRun: null };
    const resolves: Array<() => void> = [];
    let count = 0;
    const pass = async () => {
      count++;
      const myStage = count;
      // pass 1 と pass 2 は await して外部 resolve を待つ。pass 3 は即完了。
      if (myStage <= 2) {
        await new Promise<void>((r) => {
          resolves[myStage - 1] = r;
        });
      }
    };

    const first = runSerializedSync(state, pass);
    // pass 1 が「await new Promise」に入るまで microtask を進める
    while (resolves[0] === undefined) {
      await Promise.resolve();
    }
    expect(count).toBe(1);

    // pass 1 中に発射 → pass 2 を予約
    const second = runSerializedSync(state, pass);
    expect(state.pending).toBe(true);

    resolves[0]();
    // pass 2 が「await new Promise」に入るまで待つ
    while (resolves[1] === undefined) {
      await Promise.resolve();
    }
    expect(count).toBe(2);
    // pass 2 中の発射で pass 3 を予約
    const third = runSerializedSync(state, pass);
    expect(state.pending).toBe(true);

    resolves[1]();
    await Promise.all([first, second, third]);

    // pass 1 + pass 2 + pass 3 が全て走ったことを厳密に確認
    expect(count).toBe(3);
    expect(state.running).toBe(false);
    expect(state.pending).toBe(false);
  });

  test("完了後の新規発射は fresh で pass 1 を実行する", async () => {
    const state: SerializeState = { running: false, pending: false, currentRun: null };
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
    const state: SerializeState = { running: false, pending: false, currentRun: null };
    let caught: Error | undefined;
    try {
      await runSerializedSync(state, async () => {
        throw new Error("boom");
      });
    } catch (e) {
      if (e instanceof Error) caught = e;
    }
    expect(caught?.message).toBe("boom");
    expect(state.running).toBe(false);
    expect(state.pending).toBe(false);
    expect(state.currentRun).toBe(null);
  });
});

describe("whenIdle", () => {
  test("currentRun が null のときは即 resolve する", async () => {
    const state: SerializeState = { running: false, pending: false, currentRun: null };
    let resolved = false;
    await whenIdle(state).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(true);
  });

  test("in-flight の pass チェーン完走を await できる (drain primitive)", async () => {
    // `useFsWatchSync.onUnmounted` で「in-flight `runOneSyncPass` の `fsWatch` が完走する
    // 前に `rpcFsUnwatchAll` を発射する」race を防ぐ用途。drain として正しく機能することを
    // pass 1 + coalesced pass 2 の両方が `whenIdle` 経由で待てるかで verify する。
    const state: SerializeState = { running: false, pending: false, currentRun: null };
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
    // pass 1 が await まで進んだ状態にする
    while (resolveFirst === undefined) {
      await Promise.resolve();
    }
    // pass 1 中に追加発射して pass 2 を予約
    void runSerializedSync(state, pass);
    expect(state.currentRun).not.toBe(null);

    // whenIdle で drain
    const idle = whenIdle(state);
    resolveFirst();
    await idle;

    // drain 完了時点で pass 1 + 2 がどちらも完走している
    expect(count).toBe(2);
    expect(state.running).toBe(false);
    expect(state.currentRun).toBe(null);
    await first;
  });
});
