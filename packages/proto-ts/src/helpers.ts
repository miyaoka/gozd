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
