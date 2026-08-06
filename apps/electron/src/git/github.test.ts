import { describe, expect, spyOn, test } from "bun:test";
import { parseGitHubOwnerRepo, parseMyWorkNodes, parsePullRequestNodes } from "./github";

describe("parseGitHubOwnerRepo", () => {
  test("https 形式", () => {
    expect(parseGitHubOwnerRepo("https://github.com/miyaoka/gozd.git")).toEqual({
      owner: "miyaoka",
      repo: "gozd",
    });
  });

  test("scp 形式", () => {
    expect(parseGitHubOwnerRepo("git@github.com:miyaoka/gozd.git")).toEqual({
      owner: "miyaoka",
      repo: "gozd",
    });
  });

  test("ssh scheme + port", () => {
    expect(parseGitHubOwnerRepo("ssh://git@github.com:22/miyaoka/gozd")).toEqual({
      owner: "miyaoka",
      repo: "gozd",
    });
  });

  test("非 github.com host は reject", () => {
    expect(parseGitHubOwnerRepo("https://gitlab.com/group/project.git")).toBeUndefined();
    expect(parseGitHubOwnerRepo("git@ghe.example.com:org/repo.git")).toBeUndefined();
  });

  test("セグメント数不一致は reject", () => {
    expect(parseGitHubOwnerRepo("https://github.com/onlyowner")).toBeUndefined();
    expect(parseGitHubOwnerRepo("https://github.com/a/b/c")).toBeUndefined();
  });
});

const OWNER = "miyaoka";

/** PR node の snapshot。個々のテストは検証したいフィールドだけ上書きする */
function prNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 1,
    title: "t",
    url: "https://github.com/miyaoka/gozd/pull/1",
    state: "OPEN",
    isDraft: false,
    headRefName: "feat/x",
    baseRefName: "main",
    baseRefOid: "abc",
    author: { login: "miyaoka", avatarUrl: "https://example.invalid/a.png" },
    updatedAt: "2026-08-05T00:00:00Z",
    headRepository: { owner: { login: OWNER } },
    assignees: { nodes: [] },
    reviewRequests: { nodes: [] },
    statusCheckRollup: { state: "SUCCESS" },
    comments: { totalCount: 0 },
    reviews: { totalCount: 0 },
    reviewThreads: { totalCount: 0 },
    ...overrides,
  };
}

describe("parsePullRequestNodes", () => {
  test("fork PR（head owner が local owner と異なる）は除外する", () => {
    const nodes = [
      prNode({ number: 1 }),
      prNode({ number: 2, headRepository: { owner: { login: "someone-else" } } }),
    ];
    expect(parsePullRequestNodes(nodes, OWNER).map((pr) => pr.number)).toEqual([1]);
  });

  test("commentCount は会話コメント + レビュー送信 + インラインスレッドの和", () => {
    const nodes = [
      prNode({
        comments: { totalCount: 1 },
        reviews: { totalCount: 14 },
        reviewThreads: { totalCount: 15 },
      }),
    ];
    const [pr] = parsePullRequestNodes(nodes, OWNER);
    expect(pr.commentCount).toBe(30);
  });

  test("件数フィールドの欠落と非整数は 0 に倒す", () => {
    const nodes = [
      prNode({
        comments: undefined,
        reviews: { totalCount: 2.5 },
        reviewThreads: { totalCount: 3 },
      }),
    ];
    const [pr] = parsePullRequestNodes(nodes, OWNER);
    expect(pr.commentCount).toBe(3);
  });

  test("check が未登録なら checkState は undefined（ログは出さない）", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const [nullRollup] = parsePullRequestNodes([prNode({ statusCheckRollup: null })], OWNER);
      const [missing] = parsePullRequestNodes([prNode({ statusCheckRollup: undefined })], OWNER);
      expect(nullRollup.checkState).toBeUndefined();
      expect(missing.checkState).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("未知の state は undefined に倒し、観察ログを残す", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const nodes = [prNode({ statusCheckRollup: { state: "FUTURE_STATE" } })];
      const [pr] = parsePullRequestNodes(nodes, OWNER);
      expect(pr.checkState).toBeUndefined();
      expect(spy).toHaveBeenCalledWith('[prList] unknown statusCheckRollup.state: "FUTURE_STATE"');
    } finally {
      spy.mockRestore();
    }
  });

  test("既知の state はそのまま通す", () => {
    const nodes = [prNode({ statusCheckRollup: { state: "PENDING" } })];
    expect(parsePullRequestNodes(nodes, OWNER)[0].checkState).toBe("PENDING");
  });
});

/** my work の PR node snapshot。実応答（`search(type: ISSUE)` の PullRequest 側）に合わせる */
function myWorkPrNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7846,
    title: "ci: pin oasdiff install",
    url: "https://github.com/miyaoka/gozd/pull/7846",
    isDraft: false,
    updatedAt: "2026-08-05T11:07:03Z",
    repository: { nameWithOwner: "miyaoka/gozd" },
    author: { login: "miyaoka", avatarUrl: "https://example.invalid/a.png" },
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: { state: "SUCCESS" },
    comments: { totalCount: 1 },
    reviews: { totalCount: 5 },
    reviewThreads: { totalCount: 2 },
    ...overrides,
  };
}

describe("parseMyWorkNodes", () => {
  test("repo をまたぐ一覧なので帰属先 repo を行ごとに持つ", () => {
    const nodes = [
      myWorkPrNode({ repository: { nameWithOwner: "miyaoka/gozd" } }),
      myWorkPrNode({ repository: { nameWithOwner: "other-org/other-repo" } }),
    ];
    expect(parseMyWorkNodes(nodes, "pr").map((item) => item.repo)).toEqual([
      "miyaoka/gozd",
      "other-org/other-repo",
    ]);
  });

  test("fork PR を除外しない（worktree の startPoint 解決に使わないため）", () => {
    // repo 単位の `parsePullRequestNodes` は fork PR を落とすが、my work は開いて確認する
    // ための一覧なので head の所在に関係なく全件出す
    const nodes = [myWorkPrNode({ repository: { nameWithOwner: "someone-else/fork" } })];
    expect(parseMyWorkNodes(nodes, "pr")).toHaveLength(1);
  });

  test("commentCount は会話コメント + レビュー送信 + インラインスレッドの和", () => {
    const [item] = parseMyWorkNodes([myWorkPrNode()], "pr");
    expect(item.commentCount).toBe(8);
  });

  test("issue は kind=issue になり、PR 固有の要約を持たない", () => {
    const issueNode = {
      number: 17232,
      title: "dev:proxy が dev-docker の管理領域に直接書き込む",
      url: "https://github.com/miyaoka/gozd/issues/17232",
      updatedAt: "2026-08-05T05:39:22Z",
      repository: { nameWithOwner: "miyaoka/gozd" },
      author: { login: "miyaoka", avatarUrl: "https://example.invalid/a.png" },
      comments: { totalCount: 3 },
    };
    const [item] = parseMyWorkNodes([issueNode], "issue");
    expect(item.kind).toBe("issue");
    expect(item.isDraft).toBe(false);
    expect(item.checkState).toBeUndefined();
    expect(item.reviewDecision).toBeUndefined();
    expect(item.commentCount).toBe(3);
  });

  test("レビュー設定の無い PR は reviewDecision が undefined（ログは出さない）", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const [item] = parseMyWorkNodes([myWorkPrNode({ reviewDecision: null })], "pr");
      expect(item.reviewDecision).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("未知の reviewDecision は undefined に倒し、観察ログを残す", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const [item] = parseMyWorkNodes([myWorkPrNode({ reviewDecision: "FUTURE_DECISION" })], "pr");
      expect(item.reviewDecision).toBeUndefined();
      expect(spy).toHaveBeenCalledWith('[myWork] unknown reviewDecision: "FUTURE_DECISION"');
    } finally {
      spy.mockRestore();
    }
  });

  test("未知の checkState は myWork タグでログを残す", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const nodes = [myWorkPrNode({ statusCheckRollup: { state: "FUTURE_STATE" } })];
      expect(parseMyWorkNodes(nodes, "pr")[0].checkState).toBeUndefined();
      expect(spy).toHaveBeenCalledWith('[myWork] unknown statusCheckRollup.state: "FUTURE_STATE"');
    } finally {
      spy.mockRestore();
    }
  });
});
