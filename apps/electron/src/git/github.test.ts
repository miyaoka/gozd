import { describe, expect, spyOn, test } from "bun:test";
import {
  aliasedNodes,
  parseIssueListResponse,
  parsePrListResponse,
  BADGE_PR_WINDOW,
  badgeQuery,
  connectionAt,
  emptyMyWork,
  formatGhCostLine,
  ISSUE_QUERY,
  MY_WORK_QUERY,
  newestPerBranch,
  RATE_LIMIT_FIELD,
  parseGitHubOwnerRepo,
  parseMyWorkNodes,
  parseMyWorkResponse,
  parsePullRequestBadgeNodes,
  parsePullRequestNodes,
  PR_LIST_QUERY,
} from "./github";

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

describe("parsePullRequestBadgeNodes の要約", () => {
  test("fork PR（head owner が local owner と異なる）は除外する", () => {
    const nodes = [
      prNode({ number: 1 }),
      prNode({ number: 2, headRepository: { owner: { login: "someone-else" } } }),
    ];
    expect(parsePullRequestBadgeNodes(nodes, OWNER).map((pr) => pr.number)).toEqual([1]);
  });

  test("commentCount は会話コメント + レビュー送信 + インラインスレッドの和", () => {
    const nodes = [
      prNode({
        comments: { totalCount: 1 },
        reviews: { totalCount: 14 },
        reviewThreads: { totalCount: 15 },
      }),
    ];
    const [pr] = parsePullRequestBadgeNodes(nodes, OWNER);
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
    const [pr] = parsePullRequestBadgeNodes(nodes, OWNER);
    expect(pr.commentCount).toBe(3);
  });

  test("check が未登録なら checkState は undefined（ログは出さない）", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const [nullRollup] = parsePullRequestBadgeNodes([prNode({ statusCheckRollup: null })], OWNER);
      const [missing] = parsePullRequestBadgeNodes(
        [prNode({ statusCheckRollup: undefined })],
        OWNER,
      );
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
      const [pr] = parsePullRequestBadgeNodes(nodes, OWNER);
      expect(pr.checkState).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(
        '[prsForBranches] unknown statusCheckRollup.state: "FUTURE_STATE"',
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("既知の state はそのまま通す", () => {
    const nodes = [prNode({ statusCheckRollup: { state: "PENDING" } })];
    expect(parsePullRequestBadgeNodes(nodes, OWNER)[0].checkState).toBe("PENDING");
  });
});

/** stack 全体の base commit OID */
const STACK_BASE_OID = "db45e9d81f80091fd0357aa834030cf0fb29ca9b";

/** 4 段 stack の position 2 に居る PR の応答 snapshot */
function stackFields(stackOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stackEntry: { position: 2 },
    stack: {
      number: 17638,
      size: 4,
      entries: {
        nodes: [
          { position: 1, pullRequest: { baseRefOid: STACK_BASE_OID } },
          { position: 2, pullRequest: { baseRefOid: "66098eb6" } },
          { position: 3, pullRequest: { baseRefOid: "2f68f122" } },
          { position: 4, pullRequest: { baseRefOid: "878532b8" } },
        ],
      },
      ...stackOverrides,
    },
  };
}

describe("parsePullRequestBadgeNodes の stack", () => {
  test("stack に属さない PR は stack が undefined になり、ログも出ない", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const [nullStack] = parsePullRequestBadgeNodes([prNode({ stack: null })], OWNER);
      const [missing] = parsePullRequestBadgeNodes([prNode()], OWNER);
      expect(nullStack.stack).toBeUndefined();
      expect(missing.stack).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("base 端の OID は position 1 の PR の base になる（自分の直下の PR ではない）", () => {
    const [pr] = parsePullRequestBadgeNodes(
      [prNode({ ...stackFields(), baseRefOid: "878532b8" })],
      OWNER,
    );
    expect(pr.stack).toEqual({
      size: 4,
      position: 2,
      baseRefOid: STACK_BASE_OID,
    });
    expect(pr.baseRefOid).toBe("878532b8");
  });

  test("entries が position 昇順で並んでいなくても position 1 を base 端に選ぶ", () => {
    const shuffled = stackFields({
      entries: {
        nodes: [
          { position: 3, pullRequest: { baseRefOid: "2f68f122" } },
          { position: 1, pullRequest: { baseRefOid: STACK_BASE_OID } },
          { position: 2, pullRequest: { baseRefOid: "66098eb6" } },
        ],
      },
    });
    const [pr] = parsePullRequestBadgeNodes([prNode(shuffled)], OWNER);
    expect(pr.stack?.baseRefOid).toBe(STACK_BASE_OID);
  });

  test("position 1 の entry が無ければ stack なしに倒し、観察ログを残す", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const truncated = stackFields({
        entries: { nodes: [{ position: 2, pullRequest: { baseRefOid: "66098eb6" } }] },
      });
      const [pr] = parsePullRequestBadgeNodes([prNode(truncated)], OWNER);
      expect(pr.stack).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(
        "[parseStack] incomplete stack: stackNumber=17638 position=2 baseRefOid=''",
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("stack があるのに位置が取れなければ stack なしに倒し、観察ログを残す", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const nodes = [prNode({ ...stackFields(), stackEntry: null })];
      const [pr] = parsePullRequestBadgeNodes(nodes, OWNER);
      expect(pr.stack).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(
        `[parseStack] incomplete stack: stackNumber=17638 position=0 baseRefOid='${STACK_BASE_OID}'`,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

/** my work の PR node snapshot。実応答（`search(type: ISSUE)` の PullRequest 側）に合わせる */
function myWorkPrNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7846,
    title: "ci: pin oasdiff install",
    url: "https://github.com/miyaoka/gozd/pull/7846",
    isDraft: false,
    isReadByViewer: true,
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
      isReadByViewer: true,
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

  test("viewer が読んでいない項目は未読になる", () => {
    const [item] = parseMyWorkNodes([myWorkPrNode({ isReadByViewer: false })], "pr");
    expect(item.isUnread).toBe(true);
  });

  test("viewer が読んだ項目は未読にならない", () => {
    const [item] = parseMyWorkNodes([myWorkPrNode({ isReadByViewer: true })], "pr");
    expect(item.isUnread).toBe(false);
  });

  test("既読状態が取れない項目は未読にせず、取れなかった件数を観察ログに残す", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const nodes = [myWorkPrNode({ isReadByViewer: null }), myWorkPrNode()];
      const items = parseMyWorkNodes(nodes, "pr");
      expect(items[0].isUnread).toBe(false);
      expect(spy).toHaveBeenCalledWith("[myWork] missing isReadByViewer: 1/2 nodes");
    } finally {
      spy.mockRestore();
    }
  });

  test("既読状態が全件揃っていれば観察ログを出さない", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      parseMyWorkNodes([myWorkPrNode(), myWorkPrNode({ isReadByViewer: false })], "pr");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("mixed 軸は __typename で行の種別を判定する", () => {
    const nodes = [
      myWorkPrNode({ __typename: "PullRequest" }),
      {
        __typename: "Issue",
        number: 17232,
        title: "dev:proxy が dev-docker の管理領域に直接書き込む",
        url: "https://github.com/miyaoka/gozd/issues/17232",
        isReadByViewer: true,
        updatedAt: "2026-08-05T05:39:22Z",
        repository: { nameWithOwner: "miyaoka/gozd" },
        author: { login: "miyaoka", avatarUrl: "https://example.invalid/a.png" },
        comments: { totalCount: 3 },
      },
    ];
    expect(parseMyWorkNodes(nodes, "mixed").map((item) => item.kind)).toEqual(["pr", "issue"]);
  });

  test("mixed 軸の未知の __typename は issue に倒し、観察ログを残す", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const nodes = [myWorkPrNode({ __typename: "FutureType" })];
      expect(parseMyWorkNodes(nodes, "mixed")[0].kind).toBe("issue");
      expect(spy).toHaveBeenCalledWith('[myWork] unknown __typename: "FutureType"');
    } finally {
      spy.mockRestore();
    }
  });
});

describe("MY_WORK_QUERY", () => {
  test("mixed 軸の nodes selection は __typename を要求する", () => {
    // fixture は __typename を直接持つため、query 側の selection から落ちても他のテストは
    // 落ちない。mixedNodeKind が依存する結合点をここで固定する
    expect(MY_WORK_QUERY).toContain("nodes { __typename ...prFields ...issueFields }");
  });
});

/** my work query の応答 snapshot。個々のテストは検証したい軸だけ上書きする */
function myWorkResponse(overrides: Record<string, unknown> = {}): unknown {
  const group = (nodes: unknown[], issueCount: number) => ({ nodes, issueCount });
  return {
    data: {
      reviewRequestedPrs: group([myWorkPrNode()], 1),
      mentioned: group([myWorkPrNode({ __typename: "PullRequest" })], 1),
      authoredPrs: group([myWorkPrNode()], 1),
      authoredIssues: group([], 0),
      ...overrides,
    },
  };
}

describe("parseMyWorkResponse", () => {
  test("軸ごとに GitHub 上の同じ検索を開くリンクを持つ", () => {
    const result = parseMyWorkResponse(myWorkResponse());
    if (!result.ok) throw new Error("expected ok");
    const param = (url: string, key: string) => new URL(url).searchParams.get(key);

    // PR と issue で検索ページの種別が分かれる（issue の検索は is:pr を受け付けない）
    expect(result.value.authoredPrs.webLinks.map((l) => l.kind)).toEqual(["pr"]);
    expect(param(result.value.authoredPrs.webLinks[0].url, "type")).toBe("pullrequests");
    expect(param(result.value.reviewRequestedPrs.webLinks[0].url, "type")).toBe("pullrequests");
    expect(param(result.value.authoredIssues.webLinks[0].url, "type")).toBe("issues");

    // 一覧の条件がそのまま URL に載る（リンク先と一覧の母集合を一致させる契約）
    expect(param(result.value.authoredIssues.webLinks[0].url, "q")).toBe(
      "is:open is:issue author:@me archived:false sort:updated-desc",
    );
    expect(param(result.value.reviewRequestedPrs.webLinks[0].url, "q")).toBe(
      "is:open is:pr review-requested:@me archived:false sort:updated-desc",
    );
  });

  test("混在軸は種別タブごとにリンクを持ち、query は共通", () => {
    const result = parseMyWorkResponse(myWorkResponse());
    if (!result.ok) throw new Error("expected ok");
    const links = result.value.mentioned.webLinks;

    // 検索ページには混在を 1 ページに出す種別が無い。種別ごとの 2 本で母集合の和を一覧に
    // 一致させる
    expect(links.map((l) => l.kind)).toEqual(["issue", "pr"]);
    const types = links.map((l) => new URL(l.url).searchParams.get("type"));
    expect(types).toEqual(["issues", "pullrequests"]);
    for (const link of links) {
      expect(new URL(link.url).searchParams.get("q")).toBe(
        "is:open mentions:@me archived:false sort:updated-desc",
      );
    }
  });

  test("総件数が取得件数を上回るときは切れていると判定できる", () => {
    const result = parseMyWorkResponse(
      myWorkResponse({ authoredIssues: { nodes: [], issueCount: 87 } }),
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.authoredIssues.totalCount).toBe(87);
  });

  test("nodes が無い軸は応答 shape エラーにする", () => {
    const result = parseMyWorkResponse(myWorkResponse({ authoredPrs: { issueCount: 3 } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toBe("missing nodes: authoredPrs");
  });

  test("issueCount が無い軸は 0 に倒さず応答 shape エラーにする", () => {
    const result = parseMyWorkResponse(myWorkResponse({ authoredIssues: { nodes: [] } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toBe("missing issueCount: authoredIssues");
  });

  test("issueCount が数値でなければ応答 shape エラーにする", () => {
    const result = parseMyWorkResponse(
      myWorkResponse({ authoredIssues: { nodes: [], issueCount: "87" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toBe("missing issueCount: authoredIssues");
  });
});

describe("emptyMyWork", () => {
  test("失敗時でも GitHub 上で確認する導線を残す", () => {
    const empty = emptyMyWork();
    expect(empty.authoredIssues.items).toEqual([]);
    expect(empty.authoredIssues.totalCount).toBe(0);
    expect(empty.authoredIssues.webLinks[0].url).toContain("https://github.com/search?");
    expect(empty.mentioned.webLinks).toHaveLength(2);
  });

  test("軸ごとに別オブジェクトを返す", () => {
    const empty = emptyMyWork();
    expect(empty.authoredPrs).not.toBe(empty.authoredIssues);
    expect(empty.authoredPrs.items).not.toBe(empty.authoredIssues.items);
  });
});

describe("formatGhCostLine", () => {
  const response = (rateLimit: unknown) => ({ data: { rateLimit } });

  test("消費量と残量を tag 付きで並べる", () => {
    expect(formatGhCostLine(response({ cost: 3, remaining: 4961 }), "prList")).toBe(
      "[prList] cost=3 remaining=4961",
    );
  });

  test("残量 0 は観測できた値なので、そのまま出す", () => {
    expect(formatGhCostLine(response({ cost: 1, remaining: 0 }), "prList")).toBe(
      "[prList] cost=1 remaining=0",
    );
  });

  test("detail があれば末尾に足す", () => {
    expect(
      formatGhCostLine(response({ cost: 1, remaining: 10 }), "prsForBranches", "branches=55"),
    ).toBe("[prsForBranches] cost=1 remaining=10 branches=55");
  });

  test("detail が空なら末尾に何も付けない", () => {
    expect(formatGhCostLine(response({ cost: 1, remaining: 10 }), "prList", "")).toBe(
      "[prList] cost=1 remaining=10",
    );
  });

  test.each([
    ["rateLimit が null", response(null)],
    ["rateLimit が不在", response(undefined)],
    ["remaining が欠けている", response({ cost: 3 })],
    ["cost が number でない", response({ cost: "3", remaining: 1 })],
    ["応答がオブジェクトですらない", "not an object"],
  ])("%s なら値を作らず、取れなかったことを出す", (_name, parsed) => {
    expect(formatGhCostLine(parsed, "prList")).toBe("[prList] rateLimit missing in response");
  });
});

describe("GraphQL query の rateLimit", () => {
  // fixture は data.rateLimit を直接持つため、query 側の selection から落ちても
  // formatGhCostLine のテストは落ちない。消費を観測できる状態の結合点をここで固定する
  test.each([
    ["PR_LIST_QUERY", PR_LIST_QUERY],
    ["ISSUE_QUERY", ISSUE_QUERY],
    ["MY_WORK_QUERY", MY_WORK_QUERY],
    ["badgeQuery", badgeQuery(1)],
  ])("%s は rateLimit を要求する", (_name, query) => {
    expect(query).toContain(RATE_LIMIT_FIELD);
  });
});

describe("PR_LIST_QUERY", () => {
  // cursor を渡す口と次ページの有無が query から落ちると、取得は 1 ページ目だけを返して
  // 成功する。上限を超えた PR が「PR を持たない branch」と同じ見た目で消えるため、
  // ページングの結合点をここで固定する
  test("cursor を受け取り次ページの有無を返す", () => {
    expect(PR_LIST_QUERY).toContain("$after: String");
    expect(PR_LIST_QUERY).toContain("after: $after");
    expect(PR_LIST_QUERY).toContain("pageInfo { hasNextPage endCursor }");
  });
});

describe("connectionAt", () => {
  const response = (pullRequests: unknown) => ({ data: { repository: { pullRequests } } });

  test("次ページがあれば cursor を返す", () => {
    const parsed = response({
      pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29y" },
      nodes: [{}],
    });
    expect(connectionAt(parsed, "pullRequests")).toEqual({ nodes: [{}], nextCursor: "Y3Vyc29y" });
  });

  test("次ページが無ければ cursor は undefined", () => {
    const parsed = response({ pageInfo: { hasNextPage: false, endCursor: "Y3Vyc29y" }, nodes: [] });
    expect(connectionAt(parsed, "pullRequests")?.nextCursor).toBeUndefined();
  });

  // 続きがあるのに要求する手段が無い状態。「続きなし」に倒すと、切れた一覧が「取り切った」と
  // 描かれる
  test("次ページがあるのに cursor が空なら応答形式の異常として扱い、観察ログを残す", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const parsed = response({ pageInfo: { hasNextPage: true, endCursor: "" }, nodes: [] });
      expect(connectionAt(parsed, "pullRequests")).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(
        "[connectionAt] hasNextPage=true but endCursor is empty: pullRequests",
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("pageInfo を持たない query では cursor は undefined", () => {
    const parsed = response({ nodes: [{}] });
    expect(connectionAt(parsed, "pullRequests")).toEqual({ nodes: [{}], nextCursor: undefined });
  });

  test("nodes が配列でなければ応答形式の異常として undefined", () => {
    expect(connectionAt(response({ nodes: null }), "pullRequests")).toBeUndefined();
    expect(connectionAt("not an object", "pullRequests")).toBeUndefined();
  });
});

describe("badgeQuery", () => {
  // branch 名を query 文字列へ埋め込むと、名前に引用符が入った瞬間に構文が壊れる。
  // 変数宣言と参照が対で出ることを結合点として固定する
  test("branch 名は変数で渡す", () => {
    const q = badgeQuery(2);
    expect(q).toContain("$b0: String!, $b1: String!");
    expect(q).toContain("b0: pullRequests(headRefName: $b0");
    expect(q).toContain("b1: pullRequests(headRefName: $b1");
  });

  test("窓は定数と同じ値を要求する", () => {
    expect(badgeQuery(1)).toContain(`first: ${BADGE_PR_WINDOW}, states: OPEN`);
  });

  // 窓が 1 だと、捨てる fork PR 1 件で窓が埋まって自 repo の PR が見えなくなる
  test("fork を捨てても残るだけの窓を取る", () => {
    expect(BADGE_PR_WINDOW).toBeGreaterThan(1);
  });

  // newestPerBranch の先勝ちが「最新」になる唯一の根拠。落ちても実行時には検証できない
  test("同じ head の複数 PR は作成順の降順に固定する", () => {
    expect(badgeQuery(1)).toContain("orderBy: {field: CREATED_AT, direction: DESC}");
  });

  test("引く branch が 0 本なら壊れた query を返さず落とす", () => {
    expect(() => badgeQuery(0)).toThrow("count must be >= 1");
  });
});

describe("parsePullRequestNodes", () => {
  test("fork PR は除外する", () => {
    const nodes = [
      prNode({ number: 1 }),
      prNode({ number: 2, headRepository: { owner: { login: "someone-else" } } }),
    ];
    expect(parsePullRequestNodes(nodes, OWNER).map((pr) => pr.number)).toEqual([1]);
  });

  // picker が描かないフィールドを運ぶと、取得の側にそのフィールドが必要になり応答が伸びる。
  // 運ぶ範囲を「picker が読むもの」に固定する
  test("picker が読むフィールドだけを運ぶ", () => {
    const [pr] = parsePullRequestNodes([prNode()], OWNER);
    expect(Object.keys(pr).sort()).toEqual([
      "assignees",
      "author",
      "authorAvatarUrl",
      "headRef",
      "isDraft",
      "number",
      "reviewers",
      "title",
      "updatedAt",
      "url",
    ]);
  });
});

describe("newestPerBranch", () => {
  const badge = (number: number, headRef: string) =>
    ({ number, headRef }) as unknown as Parameters<typeof newestPerBranch>[0][number];

  // node は alias 内 CREATED_AT DESC 順で届くので先勝ちが最新。畳まずに流すと受け側の
  // Map が後勝ちで最古を選ぶ
  test("同じ branch は先に来たものだけ残す", () => {
    const result = newestPerBranch([badge(30, "a"), badge(10, "a"), badge(20, "b")]);
    expect(result.map((pr) => pr.number)).toEqual([30, 20]);
  });

  test("branch が重ならなければそのまま", () => {
    const result = newestPerBranch([badge(1, "a"), badge(2, "b")]);
    expect(result.map((pr) => pr.number)).toEqual([1, 2]);
  });
});

describe("aliasedNodes", () => {
  const response = (aliases: Record<string, unknown>) => ({ data: { repository: aliases } });

  test("alias を要求順に 1 本へ潰す", () => {
    const parsed = response({ b0: { nodes: [{ n: 1 }] }, b1: { nodes: [{ n: 2 }, { n: 3 }] } });
    expect(aliasedNodes(parsed, 2)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test("PR を持たない alias は空のまま飛ばす", () => {
    const parsed = response({ b0: { nodes: [] }, b1: { nodes: [{ n: 1 }] } });
    expect(aliasedNodes(parsed, 2)).toEqual([{ n: 1 }]);
  });

  // 1 つでも欠けていれば、その往復で引いた branch の結果を信用できない
  test("alias が欠けていれば応答形式の異常として undefined", () => {
    expect(aliasedNodes(response({ b0: { nodes: [] } }), 2)).toBeUndefined();
    expect(aliasedNodes(response({ b0: { nodes: null } }), 1)).toBeUndefined();
    expect(aliasedNodes("not an object", 1)).toBeUndefined();
  });
});

describe("parsePrListResponse", () => {
  const response = (over: Record<string, unknown> = {}) => ({
    data: {
      repository: {
        total: { totalCount: 152 },
        pullRequests: {
          pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29y" },
          nodes: [prNode({ number: 7 })],
        },
        ...over,
      },
    },
  });

  test("1 ページを prs / nextCursor / totalCount へ畳む", () => {
    const result = parsePrListResponse(response(), OWNER);
    expect(result.ok && result.value).toEqual({
      prs: parsePullRequestNodes([prNode({ number: 7 })], OWNER),
      nextCursor: "Y3Vyc29y",
      totalCount: 152,
    });
  });

  // 0 に倒すと「行が並んでいるのに総件数 0」という事実でない要約が描かれる
  test("totalCount が number でなければ応答形式の異常にする", () => {
    for (const total of [undefined, null, {}, { totalCount: "152" }]) {
      const result = parsePrListResponse(response({ total }), OWNER);
      expect(result.ok).toBe(false);
    }
  });

  test("Result で包んだ値を渡しても総件数を拾わない（包みを剥がす契約）", () => {
    const wrapped = { ok: true, value: response() };
    expect(parsePrListResponse(wrapped, OWNER).ok).toBe(false);
  });

  test("nodes が無ければ応答形式の異常にする", () => {
    expect(parsePrListResponse(response({ pullRequests: { nodes: null } }), OWNER).ok).toBe(false);
  });
});

describe("parseIssueListResponse", () => {
  const response = (issues: unknown) => ({ data: { repository: { issues } } });

  test("nodes を GitIssue へ畳む", () => {
    const parsed = response({
      nodes: [
        {
          number: 3,
          title: "t",
          url: "https://github.com/o/r/issues/3",
          state: "OPEN",
          author: { login: "miyaoka", avatarUrl: "https://example.invalid/a.png" },
          updatedAt: "2026-08-05T00:00:00Z",
          labels: { nodes: [{ name: "bug" }] },
          assignees: { nodes: [{ login: "miyaoka" }] },
        },
      ],
    });
    const result = parseIssueListResponse(parsed);
    expect(result.ok && result.value[0]).toMatchObject({
      number: 3,
      title: "t",
      labels: ["bug"],
      assignees: ["miyaoka"],
    });
  });

  test("Result で包んだ値を渡すと応答形式の異常になる（包みを剥がす契約）", () => {
    const wrapped = { ok: true, value: response({ nodes: [] }) };
    expect(parseIssueListResponse(wrapped).ok).toBe(false);
  });

  test("nodes が無ければ応答形式の異常にする", () => {
    expect(parseIssueListResponse(response({ nodes: null })).ok).toBe(false);
  });
});
