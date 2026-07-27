/**
 * push listener の失敗を event-log パネルに流す。
 *
 * shared/rpc と shared/debug の橋渡し。shared 間の依存は禁じられているため、
 * 上位層（layout feature）でこの bridge を組む（`useCommandErrorBridge` と同じ形）。
 *
 * 行き先をトーストにしないのは、listener の throw が「ユーザーが行動できる通知」ではなく
 * 実装バグの観測であり、かつ push には ptyText のように高頻度で流れる type があるため。
 * 恒常的に throw する listener が 1 つあるだけでトーストが上限まで埋まり、通知センターが
 * 観察不能になる（docs/architecture.md の「行動可能なものだけ user-facing、
 * それ以外はログチャンネル」に従う）。event-log は ring buffer なので溢れない。
 */
import { logEvent } from "../../shared/debug";
import { setListenerErrorReporter } from "../../shared/rpc";

export function useRpcListenerErrorBridge() {
  setListenerErrorReporter((type, cause) => {
    // stack を落とさないよう Error はそのまま文字列化する（detail は表示用の 1 行）
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    logEvent("rpc", "listener-error", type, detail);
    console.error(`[dispatchToListeners] listener failed type=${type}`, cause);
  });
}
