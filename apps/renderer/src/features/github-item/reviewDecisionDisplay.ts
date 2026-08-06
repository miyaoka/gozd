// PR のレビュー総合結果を描くときの共通語彙。
import type { GitPullRequestReviewDecision } from "@gozd/rpc";

/**
 * レビュー総合結果 → ラベルと色。
 *
 * undefined はレビューの設定が無い PR を表し、issue も同じ undefined に落ちる。
 * その扱いは docs/git.md の「得られなかった要約は描かない」。
 */
export const REVIEW_DECISION_DISPLAY: Record<
  GitPullRequestReviewDecision,
  { label: string; class: string }
> = {
  APPROVED: { label: "approved", class: "text-success-text" },
  CHANGES_REQUESTED: { label: "changes requested", class: "text-destructive-text" },
  REVIEW_REQUIRED: { label: "review required", class: "text-foreground-muted" },
};
