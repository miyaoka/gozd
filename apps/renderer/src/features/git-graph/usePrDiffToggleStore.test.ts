import type { GitPullRequest } from "@gozd/rpc";
import { describe, expect, test } from "bun:test";
import { prDiffBaseOid } from "./usePrDiffToggleStore";

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
      number: 17638,
      size: 4,
      position: 4,
      baseRef: "dev",
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

  // 空文字は「取れなかった」を表す。rev として渡すと merge-base が HEAD 起点に化けるため通さない
  test("空文字の base 端は解決できないものとして扱う", () => {
    expect(prDiffBaseOid(pr({ baseRefOid: "" }), "pr")).toBeUndefined();
    expect(prDiffBaseOid(stackedPr({ baseRefOid: "" }), "stack")).toBeUndefined();
  });

  test("stack 側が空文字でも PR 側の base 端は生きている", () => {
    expect(prDiffBaseOid(stackedPr({ baseRefOid: "" }), "pr")).toBe(PR_BASE_OID);
  });
});
