import type { GhRef, GhRefKind } from "./common";

// `GhRefKind` の文字列は barrel から export せず、本ヘルパー越しでしか `kind` を
// 組み立てられないようにする。呼び出し側で `kind` を取り違える可能性を構造的に排除する。
export const ghRefForPr = (number: number): GhRef => ({
  kind: "GH_REF_KIND_PR",
  number,
});

export const ghRefForIssue = (number: number): GhRef => ({
  kind: "GH_REF_KIND_ISSUE",
  number,
});

const GH_REF_KIND_LABEL: Record<GhRefKind, string> = {
  GH_REF_KIND_PR: "PR",
  GH_REF_KIND_ISSUE: "Issue",
};

/** GhRef を表示用ラベル ("PR #42" / "Issue #7") に変換する。
 *  renderer 側での kind 文字列直接比較を避けるための SSOT。 */
export const ghRefLabel = (ref: GhRef): string => `${GH_REF_KIND_LABEL[ref.kind]} #${ref.number}`;
