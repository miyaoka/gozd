// PR のレビュー総合結果を描くときの共通語彙。
import type { GitPullRequestReviewDecision } from "@gozd/rpc";

/**
 * レビュー総合結果 → ラベルと色。
 *
 * 表示側は undefined を「レビューの設定が無い PR」と読み、何も描かない。issue も同じ
 * undefined に落ちる。「不明」を表す専用の見た目は持たない。
 */
export const REVIEW_DECISION_DISPLAY: Record<
  GitPullRequestReviewDecision,
  { label: string; class: string }
> = {
  APPROVED: { label: "approved", class: "text-success-text" },
  CHANGES_REQUESTED: { label: "changes requested", class: "text-destructive-text" },
  REVIEW_REQUIRED: { label: "review required", class: "text-foreground-muted" },
};
