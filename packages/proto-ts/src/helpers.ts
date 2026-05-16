import { type GhRef, GhRefKind } from "./generated/gozd/v1/common";

// `kind` の hardcode を呼び出し側から消し、proto enum (GhRefKind) を業務コードに
// 露出させないためのドメインヘルパー。GitHub の番号空間共有を踏まえ、PR / issue を
// 1 行で表現する。
export const ghRefForPr = (number: number): GhRef => ({
  kind: GhRefKind.GH_REF_KIND_PR,
  number,
});

export const ghRefForIssue = (number: number): GhRef => ({
  kind: GhRefKind.GH_REF_KIND_ISSUE,
  number,
});
