// PR の CI 総合結果を描くときの共通語彙。git-graph の ref バッジと my-work パネルの双方が
// 同じドット色 / tooltip を使うため、マッピングをここに 1 つだけ置く。
import type { GitPullRequestCheckState } from "@gozd/rpc";

/**
 * CI 総合結果 → ドットの色と tooltip。
 *
 * `ERROR` (インフラ起因の異常終了) と `FAILURE` (チェック自体の失敗) は「直さないと merge
 * できない」点で利用者の次の行動が同じなので同色に潰す。`EXPECTED` は必須チェックがまだ
 * 報告されていない待ち状態なので `PENDING` と同色。
 */
export const CHECK_STATE_DISPLAY: Record<
  GitPullRequestCheckState,
  { class: string; title: string }
> = {
  SUCCESS: { class: "bg-success", title: "All checks passing" },
  FAILURE: { class: "bg-destructive", title: "Some checks failing" },
  ERROR: { class: "bg-destructive", title: "Checks errored" },
  PENDING: { class: "bg-warning", title: "Checks running" },
  EXPECTED: { class: "bg-warning", title: "Checks expected" },
};
