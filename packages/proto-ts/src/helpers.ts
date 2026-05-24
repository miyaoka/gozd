import { type GhRef, GhRefKind } from "./generated/gozd/v1/common";

// `GhRefKind` は barrel から export せず、本ヘルパー越しでしか `kind` を組み立てられない
// ようにする。呼び出し側で `kind` を取り違える可能性を構造的に排除する。
export const ghRefForPr = (number: number): GhRef => ({
  kind: GhRefKind.GH_REF_KIND_PR,
  number,
});

export const ghRefForIssue = (number: number): GhRef => ({
  kind: GhRefKind.GH_REF_KIND_ISSUE,
  number,
});

/** GhRef を表示用ラベル ("PR #42" / "Issue #7") に変換する。
 *  renderer 側で `kind === 1` のようなマジックナンバー比較を避けるための SSOT。 */
export const ghRefLabel = (ref: GhRef): string => {
  switch (ref.kind) {
    case GhRefKind.GH_REF_KIND_PR:
      return `PR #${ref.number}`;
    case GhRefKind.GH_REF_KIND_ISSUE:
      return `Issue #${ref.number}`;
    default:
      return `#${ref.number}`;
  }
};
