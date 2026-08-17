import { describe, expect, spyOn, test } from "bun:test";
import {
  emptyMyWork,
  MY_WORK_QUERY,
  parseGitHubOwnerRepo,
  parseMyWorkNodes,
  parseMyWorkResponse,
  parsePullRequestNodes,
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

/** stack 全体の base commit OID。position 1 の PR の base として応答に現れる */
const STACK_BASE_OID = "db45e9d81f80091fd0357aa834030cf0fb29ca9b";

/** 4 段 stack の position 2 に居る PR の応答 snapshot。stack の中身だけ差し替えられる */
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

describe("parsePullRequestNodes の stack", () => {
  test("stack に属さない PR は stack が undefined になり、ログも出ない", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const [nullStack] = parsePullRequestNodes([prNode({ stack: null })], OWNER);
      const [missing] = parsePullRequestNodes([prNode()], OWNER);
      expect(nullStack.stack).toBeUndefined();
      expect(missing.stack).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("base 端の OID は position 1 の PR の base になる（自分の直下の PR ではない）", () => {
    const [pr] = parsePullRequestNodes(
      [prNode({ ...stackFields(), baseRefOid: "878532b8" })],
      OWNER,
    );
    expect(pr.stack).toEqual({
      size: 4,
      position: 2,
      baseRefOid: STACK_BASE_OID,
    });
    // PR 自身の base 端は stack の base 端と別物として残る
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
    const [pr] = parsePullRequestNodes([prNode(shuffled)], OWNER);
    expect(pr.stack?.baseRefOid).toBe(STACK_BASE_OID);
  });

  test("position 1 の entry が無ければ stack なしに倒し、観察ログを残す", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const truncated = stackFields({
        entries: { nodes: [{ position: 2, pullRequest: { baseRefOid: "66098eb6" } }] },
      });
      const [pr] = parsePullRequestNodes([prNode(truncated)], OWNER);
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
      const [pr] = parsePullRequestNodes(nodes, OWNER);
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
