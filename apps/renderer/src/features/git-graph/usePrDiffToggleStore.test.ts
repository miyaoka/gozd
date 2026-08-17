import type { GitPullRequest } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import type { PrDiffOrigin } from "./usePrDiffToggleStore";
import { isPrDiffOriginStale, prDiffBaseOid } from "./usePrDiffToggleStore";

const PR_BASE_OID = "878532b8b72fa424e9daf50261e1fe752e5ada6b";
const STACK_BASE_OID = "db45e9d81f80091fd0357aa834030cf0fb29ca9b";

/** PR の snapshot。base 端の解決に関わるフィールドだけ差し替える */
function pr(overrides: Partial<GitPullRequest> = {}): GitPullRequest {
  return {
    number: 17637,
    title: "chore: cleanup",
    url: "https://github.com/o/r/pull/17637",
    state: "OPEN",
    author: "miyaoka",
    headRef: "chore/billing-form-cleanup",
    baseRef: "fix/billing-submit-and-destroy",
    isDraft: false,
    assignees: [],
    reviewers: [],
    updatedAt: "2026-08-17T07:43:47Z",
    authorAvatarUrl: "https://example.invalid/a.png",
    baseRefOid: PR_BASE_OID,
    commentCount: 0,
    ...overrides,
  };
}

/** 4 段 stack の最上段に居る PR */
function stackedPr(stackOverrides: Partial<GitPullRequest["stack"]> = {}): GitPullRequest {
  return pr({
    stack: {
      size: 4,
      position: 4,
      baseRefOid: STACK_BASE_OID,
      ...stackOverrides,
    },
  });
}

describe("prDiffBaseOid", () => {
  test("mode pr は PR 自身の base 端を返す", () => {
    expect(prDiffBaseOid(pr(), "pr")).toBe(PR_BASE_OID);
  });

  test("mode stack は stack 全体の base 端を返す（自分の直下の PR ではない）", () => {
    expect(prDiffBaseOid(stackedPr(), "stack")).toBe(STACK_BASE_OID);
  });

  test("stack に属していても mode pr は PR 自身の base 端のまま", () => {
    expect(prDiffBaseOid(stackedPr(), "pr")).toBe(PR_BASE_OID);
  });

  test("stack に属さない PR で mode stack は解決できない", () => {
    expect(prDiffBaseOid(pr(), "stack")).toBeUndefined();
  });

  test("PR が無ければどちらの mode も解決できない", () => {
    expect(prDiffBaseOid(undefined, "pr")).toBeUndefined();
    expect(prDiffBaseOid(undefined, "stack")).toBeUndefined();
  });

  // 空文字は「取れなかった」を表す。git には fatal になるだけだが、解決チェーンへ入れると fetch を
  // 空撃ちしたうえで merge-base 失敗が unrelated histories として通知され、原因が誤分類される
  test("空文字の base 端は解決できないものとして扱う", () => {
    expect(prDiffBaseOid(pr({ baseRefOid: "" }), "pr")).toBeUndefined();
    expect(prDiffBaseOid(stackedPr({ baseRefOid: "" }), "stack")).toBeUndefined();
  });

  test("stack 側が空文字でも PR 側の base 端は生きている", () => {
    expect(prDiffBaseOid(stackedPr({ baseRefOid: "" }), "pr")).toBe(PR_BASE_OID);
  });
});

const DIR = "/w/repo";
const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** enable() 開始時の起点入力 */
function origin(overrides: Partial<PrDiffOrigin> = {}): PrDiffOrigin {
  return { dir: DIR, baseOid: STACK_BASE_OID, headHash: HEAD_A, ...overrides };
}

describe("isPrDiffOriginStale", () => {
  test("何も動いていなければ stale ではない", () => {
    expect(isPrDiffOriginStale(origin(), origin())).toBe(false);
  });

  // CodeRabbit の指摘の本体。同じ既定ブランチから切った PR 同士は base OID が同値になるため、
  // base だけを見ていると branch 切替を取りこぼし、古い HEAD の merge-base を固定してしまう
  test("base OID が同値のまま HEAD だけ動いたら stale", () => {
    expect(isPrDiffOriginStale(origin(), origin({ headHash: HEAD_B }))).toBe(true);
  });

  test("base 端が動いたら stale", () => {
    expect(isPrDiffOriginStale(origin(), origin({ baseOid: PR_BASE_OID }))).toBe(true);
  });

  test("dir が動いたら stale", () => {
    expect(isPrDiffOriginStale(origin(), origin({ dir: "/w/other" }))).toBe(true);
  });

  test("dir / base 端の消失は前提そのものが失われるので stale", () => {
    expect(isPrDiffOriginStale(origin(), origin({ dir: undefined }))).toBe(true);
    expect(isPrDiffOriginStale(origin(), origin({ baseOid: undefined }))).toBe(true);
  });

  // commit グラフのロード中に HEAD が一時的に解決できないのは UI 側の都合で、HEAD が動いた証拠ではない
  test("HEAD の不明は動いたと扱わない", () => {
    expect(isPrDiffOriginStale(origin(), origin({ headHash: undefined }))).toBe(false);
  });

  test("HEAD が不明でも dir が動いていれば stale", () => {
    expect(isPrDiffOriginStale(origin(), origin({ dir: "/w/other", headHash: undefined }))).toBe(
      true,
    );
  });
});
