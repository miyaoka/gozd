/**
 * single-flight + coalesce な async runner。
 *
 * - `pass` が in-flight 中に再度呼ばれた場合、即 return して `pending` フラグだけ立てる
 * - in-flight の `pass` 完了後、`pending` が立っていれば追加で 1 回だけ `pass` を実行
 * - 複数回の重複呼び出しは 1 回の追加 pass に畳まれる（coalesce）
 *
 * `useFsWatchSync` の `syncWatches` から切り出した。`watchEffect` は依存変更で即時再 run
 * するが前回の async 完了を待たないため、並列発射で内部 state（`watchedDirs` 等）の
 * 整合性が壊れる race を構造的に防ぐ。
 *
 * pure な module-level 関数にすることで bun test で race / coalesce 挙動を直接検証できる。
 * production 側は呼び出し元 closure が `state` を保持し、`runSerializedSync` を呼ぶ。
 */
export interface SerializeState {
  running: boolean;
  pending: boolean;
  /**
   * in-flight の pass チェーン全体（最初の caller が起動し、coalesce された pending を
   * 含めて全 pass が完走するまで resolve しない）。後乗りした呼び出しは `pending` だけ
   * 立てて即 return するが、外部から `whenIdle(state)` 越しに完走を await できる。
   * 完走後の finally で null に戻る。
   */
  currentRun: Promise<void> | null;
}

export async function runSerializedSync(
  state: SerializeState,
  pass: () => Promise<void>,
): Promise<void> {
  if (state.running) {
    state.pending = true;
    return;
  }
  state.running = true;
  const run = (async () => {
    try {
      do {
        state.pending = false;
        await pass();
      } while (state.pending);
    } finally {
      state.running = false;
      state.currentRun = null;
    }
  })();
  state.currentRun = run;
  await run;
}

/**
 * 現在 in-flight の pass チェーンが完走するまで await する。in-flight が無ければ即 resolve。
 *
 * `useFsWatchSync` の `onUnmounted` で「in-flight `runOneSyncPass` の `fsWatch` が
 * native で entry を登録する前に `rpcFsUnwatchAll` を発射する」race を構造的に潰すための
 * drain primitive。caller 側で `disposing` ガードを立てて新規 pass の start を抑制した上で
 * `whenIdle` で in-flight を待ち、 そこから unwatchAll を発射する流れ。
 */
export async function whenIdle(state: SerializeState): Promise<void> {
  if (state.currentRun !== null) {
    await state.currentRun;
  }
}
