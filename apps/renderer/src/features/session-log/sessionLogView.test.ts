import type { TranscriptEvent } from "@gozd/claude-session-log";
import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import {
  buildSubagentLinks,
  buildTimelineTracks,
  formatModelLabel,
  formatSessionTime,
  groupByWorkflow,
  nearestEventIndexByTs,
  newestSubagentTrackId,
  sessionTimeRange,
  subagentTabLabel,
  timelineAxisRange,
  type SubagentDescriptor,
  type TimelineSession,
  type WorkflowGroupItem,
} from "./sessionLogView";

const TS = "2026-05-31T10:00:00.000Z";

describe("formatSessionTime", () => {
  // now を正午に固定し today / 別日分岐を決定的にする。ts は丸 1 日 / 年単位でずらすため、
  // どの TZ でも同一インスタンスは同じカレンダー日、24h ずれは必ず別日になり境界フレークが出ない。
  // 日付文字列の区切り順は toLocaleDateString のロケール依存なので exact 比較せず、
  // 「別年は 4 桁年を含む / 同年別日は含まない」という構造で年区別を検証する。
  const NOW = new Date("2026-05-31T12:00:00.000Z");
  setSystemTime(NOW);
  afterAll(() => setSystemTime());

  test("空文字は date / time とも空", () => {
    expect(formatSessionTime("")).toEqual({ date: "", time: "" });
  });

  test("不正な ISO は date / time とも空", () => {
    expect(formatSessionTime("not-a-date")).toEqual({ date: "", time: "" });
  });

  test("今日は date 空で time のみ", () => {
    const result = formatSessionTime(NOW.toISOString());
    expect(result.date).toBe("");
    expect(result.time).not.toBe("");
  });

  test("seconds: false は時・分の 2 セグメント、true は秒を含む 3 セグメント", () => {
    const ts = NOW.toISOString();
    // 区切り文字はロケール依存なので、数値セグメント数で「分まで出す / 秒を含む」を直接検証する
    // (length 比較だと分まで落とす退行をすり抜けるため)。hour12: false なので AM/PM 由来の
    // 余分なトークンは入らない。
    const withSeconds = formatSessionTime(ts, { seconds: true }).time.match(/\d+/g) ?? [];
    const withoutSeconds = formatSessionTime(ts, { seconds: false }).time.match(/\d+/g) ?? [];
    expect(withoutSeconds).toHaveLength(2);
    expect(withSeconds).toHaveLength(3);
  });

  test("同年別日は date を持ち、4 桁年を含まない (M/D)", () => {
    const result = formatSessionTime("2026-01-15T12:00:00.000Z");
    expect(result.date).not.toBe("");
    expect(result.date).not.toContain("2026");
    expect(result.time).not.toBe("");
  });

  test("別年は date に 4 桁年を含む (YYYY/M/D)", () => {
    const result = formatSessionTime("2024-05-31T12:00:00.000Z");
    expect(result.date).toContain("2024");
    expect(result.time).not.toBe("");
  });
});

describe("buildSubagentLinks", () => {
  // tool event を 1 つ作る helper。toolUseId / name / input / result (+その agentId / promptId) を指定する。
  function toolEvent(
    name: string,
    toolUseId: string,
    input: Record<string, unknown> = {},
    resultText?: string,
    promptId = "",
    agentId = "",
  ): TranscriptEvent {
    return {
      kind: "tool",
      name,
      input,
      toolUseId,
      ts: TS,
      result:
        resultText === undefined
          ? undefined
          : { text: resultText, isError: false, agentId, promptId },
    };
  }
  function sub(over: Partial<SubagentDescriptor>): SubagentDescriptor {
    return {
      id: "",
      label: "",
      name: "",
      agentType: "",
      parentToolUseId: "",
      rootPromptId: "",
      workflowRunId: "",
      workflowName: "",
      ...over,
    };
  }

  test("Agent は tool_use.id == subagent.parentToolUseId で結ぶ", () => {
    const links = buildSubagentLinks(
      [toolEvent("Agent", "toolu_A")],
      [sub({ id: "agent1", label: "reviewer", parentToolUseId: "toolu_A" })],
    );
    expect(links.get("toolu_A")).toEqual({ agentId: "agent1", label: "reviewer" });
  });

  test("Agent は parentToolUseId で引けないとき tool_result.promptId (subagent ファイル先頭の rootPromptId) で結ぶ", () => {
    const links = buildSubagentLinks(
      // teammate spawn: meta が toolUseId 無し、tool_result を運ぶレコードの promptId が
      // 対応 subagent ファイルの先頭レコードの promptId と厳密一致する。
      [
        toolEvent(
          "Agent",
          "toolu_A",
          { name: "a55a74b8fc5258aae" },
          "Spawned successfully.",
          "prompt-1",
        ),
      ],
      [
        sub({
          id: "aabbcc",
          label: "PR870の再レビュー依頼",
          name: "a55a74b8fc5258aae",
          agentType: "a55a74b8fc5258aae",
          rootPromptId: "prompt-1",
        }),
      ],
    );
    expect(links.get("toolu_A")).toEqual({ agentId: "aabbcc", label: "PR870の再レビュー依頼" });
  });

  test("Agent は parentToolUseId 一致を promptId フォールバックより優先する", () => {
    const links = buildSubagentLinks(
      [toolEvent("Agent", "toolu_A", {}, "ok", "prompt-1")],
      [
        sub({ id: "byTool", label: "by-tool", parentToolUseId: "toolu_A" }),
        sub({ id: "byPrompt", label: "by-prompt", rootPromptId: "prompt-1" }),
      ],
    );
    expect(links.get("toolu_A")).toEqual({ agentId: "byTool", label: "by-tool" });
  });

  test("同名 teammate を複数回 spawn しても各 Agent 呼び出しが promptId で正しい subagent に結ぶ", () => {
    // 実際に issue #872 で観測された形: 同名 (= 同 agentType) の teammate を 2 回 spawn すると、
    // tool_result のテキスト (agent_id / name) は完全一致するが、物理的には無関係な独立した
    // subagent ファイルになる。name/agentType の一致だけで結ぶと一意に決められず ambiguous に
    // なってしまうケースを、promptId が厳密に解決できることを確認する。
    const links = buildSubagentLinks(
      [
        toolEvent(
          "Agent",
          "toolu_1",
          { name: "a55a74b8fc5258aae" },
          "Spawned successfully.\nagent_id: a55a74b8fc5258aae@session-x\nname: a55a74b8fc5258aae",
          "prompt-1",
        ),
        toolEvent(
          "Agent",
          "toolu_2",
          { name: "a55a74b8fc5258aae" },
          "Spawned successfully.\nagent_id: a55a74b8fc5258aae@session-x\nname: a55a74b8fc5258aae",
          "prompt-2",
        ),
      ],
      [
        sub({
          id: "aa...-hash1",
          label: "re-review 1",
          name: "a55a74b8fc5258aae",
          agentType: "a55a74b8fc5258aae",
          rootPromptId: "prompt-1",
        }),
        sub({
          id: "aa...-hash2",
          label: "re-review 2",
          name: "a55a74b8fc5258aae",
          agentType: "a55a74b8fc5258aae",
          rootPromptId: "prompt-2",
        }),
      ],
    );
    expect(links.get("toolu_1")).toEqual({ agentId: "aa...-hash1", label: "re-review 1" });
    expect(links.get("toolu_2")).toEqual({ agentId: "aa...-hash2", label: "re-review 2" });
  });

  test("Agent は parentToolUseId で引けないとき tool_result.agentId (通常 subagent の物理 id) で結ぶ", () => {
    // run_in_background 系の通常 subagent は meta.json に toolUseId を持たないことがあるが、
    // tool_result の toolUseResult.agentId に spawn 先の物理 id が乗る (実ログで確認済み)。
    const links = buildSubagentLinks(
      [
        toolEvent(
          "Agent",
          "toolu_A",
          {},
          "Async agent launched successfully.",
          "",
          "a042cccee019f7982",
        ),
      ],
      [sub({ id: "a042cccee019f7982", label: "Summarize session" })],
    );
    expect(links.get("toolu_A")).toEqual({
      agentId: "a042cccee019f7982",
      label: "Summarize session",
    });
  });

  test("同一プロンプト処理サイクル内で複数 Agent spawn が同じ rootPromptId を共有すると、いずれもリンクを張らない", () => {
    // promptId は spawn 単位ではなく「1回のプロンプト処理サイクル」単位の id なので、
    // 1 ターンで Agent を複数回呼ぶと tool_result 全てが同じ promptId を持ちうる (実ログで確認済み、
    // 最大 10 件の Agent tool_use が同一 promptId を共有していた実例あり)。この場合 promptId では
    // 一意に決められないため、誤った subagent へ結ぶより無表示を選ぶ。
    const links = buildSubagentLinks(
      [
        toolEvent("Agent", "toolu_1", {}, "Async agent launched successfully.", "prompt-shared"),
        toolEvent("Agent", "toolu_2", {}, "Async agent launched successfully.", "prompt-shared"),
      ],
      [
        sub({ id: "s1", label: "Summarize A", rootPromptId: "prompt-shared" }),
        sub({ id: "s2", label: "Summarize B", rootPromptId: "prompt-shared" }),
      ],
    );
    expect(links.has("toolu_1")).toBe(false);
    expect(links.has("toolu_2")).toBe(false);
  });

  test("agentId を持つが未解決 (候補未到着等) の Agent 呼び出しは、rootPromptId で無関係な subagent に誤ってリンクしない", () => {
    // rootPromptId フォールバックは物理 id を一切持たない team teammate 専用の最終手段。
    // 通常 subagent (agentId 有り) がまだ subagents 一覧に現れていないだけ (live refresh の
    // タイミング差等) のケースでこの分岐に落ちると、同じ promptId を共有する無関係な
    // team teammate に誤ってリンクしてしまう。agentId が空でない限り rootPromptId は試さない。
    const links = buildSubagentLinks(
      [
        toolEvent(
          "Agent",
          "toolu_A",
          {},
          "Async agent launched successfully.",
          "prompt-shared",
          "not-yet-loaded-agent-id",
        ),
      ],
      [sub({ id: "team-x", label: "team teammate", rootPromptId: "prompt-shared" })],
    );
    expect(links.has("toolu_A")).toBe(false);
  });

  test("SendMessage は input.to == agent_id で結ぶ", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "agent1" })],
      [sub({ id: "agent1", label: "reviewer" })],
    );
    expect(links.get("toolu_S")).toEqual({ agentId: "agent1", label: "reviewer" });
  });

  test("SendMessage は input.to が agent name でも結ぶ (id 不一致時の name フォールバック)", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "reviewer" })],
      [sub({ id: "agent1", label: "PR review", name: "reviewer" })],
    );
    expect(links.get("toolu_S")).toEqual({ agentId: "agent1", label: "PR review" });
  });

  test("SendMessage は input.to が agentType (team teammate の role 名) でも結ぶ", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "ssot-reviewer" })],
      // teammate は meta が agentType のみで name/id (hex) は to と一致しない。
      [sub({ id: "aabbcc", label: "ssot-reviewer", name: "", agentType: "ssot-reviewer" })],
    );
    expect(links.get("toolu_S")).toEqual({ agentId: "aabbcc", label: "ssot-reviewer" });
  });

  test("同 agentType の subagent が複数 + to が agentType のときはリンクを張らない (一意に決められない)", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "ssot-reviewer" })],
      [
        sub({ id: "a1", agentType: "ssot-reviewer" }),
        sub({ id: "a2", agentType: "ssot-reviewer" }),
      ],
    );
    expect(links.has("toolu_S")).toBe(false);
  });

  test("name を agentType より優先する", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "reviewer" })],
      [
        sub({ id: "a1", label: "by-name", name: "reviewer", agentType: "other" }),
        sub({ id: "a2", label: "by-agentType", name: "", agentType: "reviewer" }),
      ],
    );
    expect(links.get("toolu_S")).toEqual({ agentId: "a1", label: "by-name" });
  });

  test("id を name より優先する", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "agent1" })],
      [
        sub({ id: "agent1", label: "by-id" }),
        sub({ id: "agent2", label: "by-name", name: "agent1" }),
      ],
    );
    expect(links.get("toolu_S")?.agentId).toBe("agent1");
  });

  test("同名 subagent が複数 + to が name のときはリンクを張らない (一意に決められない)", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "reviewer" })],
      [sub({ id: "agent1", name: "reviewer" }), sub({ id: "agent2", name: "reviewer" })],
    );
    expect(links.has("toolu_S")).toBe(false);
  });

  test("同名 subagent が複数でも to が id なら一意に引ける", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "agent2" })],
      [
        sub({ id: "agent1", label: "first", name: "reviewer" }),
        sub({ id: "agent2", label: "second", name: "reviewer" }),
      ],
    );
    expect(links.get("toolu_S")).toEqual({ agentId: "agent2", label: "second" });
  });

  test("parentToolUseId 空の subagent は Agent 紐付け対象から外す", () => {
    const links = buildSubagentLinks(
      [toolEvent("Agent", "toolu_A")],
      [sub({ id: "agent1", parentToolUseId: "" })],
    );
    expect(links.has("toolu_A")).toBe(false);
  });

  test("toolUseId 空の tool event は紐付け対象外", () => {
    const links = buildSubagentLinks(
      [toolEvent("Agent", "")],
      [sub({ id: "agent1", parentToolUseId: "" })],
    );
    expect(links.size).toBe(0);
  });

  test("引き当たらない to / 無関係 tool は map に入らない", () => {
    const links = buildSubagentLinks(
      [toolEvent("SendMessage", "toolu_S", { to: "missing" }), toolEvent("Read", "toolu_R")],
      [sub({ id: "agent1", name: "reviewer" })],
    );
    expect(links.size).toBe(0);
  });

  test("Workflow は result の Run ID で workflow agent 群の先頭に結ぶ (ラベルは名 + 件数)", () => {
    const links = buildSubagentLinks(
      [toolEvent("Workflow", "toolu_W", {}, "Workflow launched.\nRun ID: wf_abc123\n…")],
      [
        sub({ id: "ag1", workflowRunId: "wf_abc123", workflowName: "diagnose" }),
        sub({ id: "ag2", workflowRunId: "wf_abc123", workflowName: "diagnose" }),
      ],
    );
    expect(links.get("toolu_W")).toEqual({ agentId: "ag1", label: "diagnose (2)" });
  });

  test("Workflow の workflowName が空なら runId をラベル名に使う", () => {
    const links = buildSubagentLinks(
      [toolEvent("Workflow", "toolu_W", {}, "Run ID: wf_xyz")],
      [sub({ id: "ag1", workflowRunId: "wf_xyz" })],
    );
    expect(links.get("toolu_W")).toEqual({ agentId: "ag1", label: "wf_xyz (1)" });
  });

  test("Workflow の result が未記録ならリンクを張らない", () => {
    const links = buildSubagentLinks(
      [toolEvent("Workflow", "toolu_W")],
      [sub({ id: "ag1", workflowRunId: "wf_abc123" })],
    );
    expect(links.has("toolu_W")).toBe(false);
  });

  test("Workflow の result に Run ID が無ければリンクを張らない", () => {
    const links = buildSubagentLinks(
      [toolEvent("Workflow", "toolu_W", {}, "Workflow launched but no run id here")],
      [sub({ id: "ag1", workflowRunId: "wf_abc123" })],
    );
    expect(links.has("toolu_W")).toBe(false);
  });

  test("Workflow の Run ID に対応する agent が無ければリンクを張らない", () => {
    const links = buildSubagentLinks(
      [toolEvent("Workflow", "toolu_W", {}, "Run ID: wf_other")],
      [sub({ id: "ag1", workflowRunId: "wf_abc123" })],
    );
    expect(links.has("toolu_W")).toBe(false);
  });
});

describe("subagentTabLabel", () => {
  function entry(over: Partial<Parameters<typeof subagentTabLabel>[0]>) {
    return { id: "", label: "", agentType: "", phaseTitle: "", ...over };
  }

  test("phaseTitle と label が両方あれば `phaseTitle · label`", () => {
    expect(subagentTabLabel(entry({ phaseTitle: "Verify", label: "reactivity" }))).toBe(
      "Verify · reactivity",
    );
  });

  test("phaseTitle 単独でも phaseTitle を出す (label 空で取りこぼさない)", () => {
    expect(subagentTabLabel(entry({ phaseTitle: "Verify", agentType: "Explore" }))).toBe("Verify");
  });

  test("label 単独なら label", () => {
    expect(subagentTabLabel(entry({ label: "reviewer", agentType: "Explore" }))).toBe("reviewer");
  });

  test("phaseTitle / label 空なら agentType", () => {
    expect(subagentTabLabel(entry({ agentType: "Explore" }))).toBe("Explore");
  });

  test("すべて空なら agentId 先頭 8 文字", () => {
    expect(subagentTabLabel(entry({ id: "abcdef0123456789" }))).toBe("abcdef01");
  });
});

describe("groupByWorkflow", () => {
  function item(over: Partial<WorkflowGroupItem>): WorkflowGroupItem {
    return { id: "", workflowRunId: "", workflowName: "", ...over };
  }

  test("workflowRunId ごとに出現順でグループ化する", () => {
    const groups = groupByWorkflow([
      item({ id: "a1", workflowRunId: "wf_1", workflowName: "diagnose" }),
      item({ id: "a2", workflowRunId: "wf_1", workflowName: "diagnose" }),
      item({ id: "b1", workflowRunId: "wf_2", workflowName: "audit" }),
    ]);
    expect(groups).toEqual([
      {
        runId: "wf_1",
        name: "diagnose",
        agents: [
          item({ id: "a1", workflowRunId: "wf_1", workflowName: "diagnose" }),
          item({ id: "a2", workflowRunId: "wf_1", workflowName: "diagnose" }),
        ],
      },
      {
        runId: "wf_2",
        name: "audit",
        agents: [item({ id: "b1", workflowRunId: "wf_2", workflowName: "audit" })],
      },
    ]);
  });

  test("workflowRunId 空の item (非 workflow subagent) は除外する", () => {
    const groups = groupByWorkflow([
      item({ id: "plain", workflowRunId: "" }),
      item({ id: "a1", workflowRunId: "wf_1", workflowName: "diagnose" }),
    ]);
    expect(groups.map((g) => g.runId)).toEqual(["wf_1"]);
  });

  test("workflowName 空なら見出し名に runId を使う", () => {
    const groups = groupByWorkflow([item({ id: "a1", workflowRunId: "wf_1", workflowName: "" })]);
    expect(groups[0].name).toBe("wf_1");
  });

  test("先頭 agent が一貫する (buildSubagentLinks のリンク先と同一の出現順先頭)", () => {
    const groups = groupByWorkflow([
      item({ id: "first", workflowRunId: "wf_1" }),
      item({ id: "second", workflowRunId: "wf_1" }),
    ]);
    expect(groups[0].agents[0].id).toBe("first");
  });
});

describe("nearestEventIndexByTs", () => {
  function userAt(ts: string): TranscriptEvent {
    return { kind: "user", text: "x", ts };
  }

  test("最も近い ts の index を返す", () => {
    const events = [
      userAt("2026-06-01T09:00:00.000Z"),
      userAt("2026-06-01T09:06:07.000Z"),
      userAt("2026-06-01T10:00:00.000Z"),
    ];
    // SendMessage 発火 (06:06.966) の直後に注入された 06:07 のイベントへ寄せる。
    expect(nearestEventIndexByTs(events, "2026-06-01T09:06:06.966Z")).toBe(1);
  });

  test("ts 不正 / 空文字なら undefined", () => {
    expect(nearestEventIndexByTs([userAt(TS)], "")).toBeUndefined();
    expect(nearestEventIndexByTs([userAt(TS)], "not-a-date")).toBeUndefined();
  });

  test("空 events / 全 ts 不正なら undefined", () => {
    expect(nearestEventIndexByTs([], TS)).toBeUndefined();
    expect(nearestEventIndexByTs([userAt(""), userAt("bad")], TS)).toBeUndefined();
  });

  test("同値 diff のタイは最小 index を選ぶ", () => {
    const events = [userAt("2026-06-01T09:00:00.000Z"), userAt("2026-06-01T09:00:02.000Z")];
    // target はちょうど中間。両者 1000ms 差で、strict < により先(最小 index)を選ぶ。
    expect(nearestEventIndexByTs(events, "2026-06-01T09:00:01.000Z")).toBe(0);
  });
});

describe("sessionTimeRange", () => {
  function userAt(ts: string): TranscriptEvent {
    return { kind: "user", text: "x", ts };
  }

  test("順不同の ts から min start / max end を取る", () => {
    // tool イベントは result 充填の都合で ts が厳密な昇順とは限らない。順序に依存せず
    // 全件の min/max を取ることを確認する。
    const events = [
      userAt("2026-06-01T10:00:00.000Z"),
      userAt("2026-06-01T09:00:00.000Z"),
      userAt("2026-06-01T09:30:00.000Z"),
    ];
    expect(sessionTimeRange(events)).toEqual({
      startMs: Date.parse("2026-06-01T09:00:00.000Z"),
      endMs: Date.parse("2026-06-01T10:00:00.000Z"),
    });
  });

  test("ts 不正 / 空文字のイベントは除外する", () => {
    const events = [userAt(""), userAt(TS), userAt("not-a-date")];
    expect(sessionTimeRange(events)).toEqual({ startMs: Date.parse(TS), endMs: Date.parse(TS) });
  });

  test("単一イベントは start === end", () => {
    expect(sessionTimeRange([userAt(TS)])).toEqual({
      startMs: Date.parse(TS),
      endMs: Date.parse(TS),
    });
  });

  test("空 events / 全 ts 不正なら undefined", () => {
    expect(sessionTimeRange([])).toBeUndefined();
    expect(sessionTimeRange([userAt(""), userAt("bad")])).toBeUndefined();
  });
});

describe("buildTimelineTracks", () => {
  // 指定 ts のイベント列を持つ TimelineSession。ts を省くと events 空 (生存期間なし)。
  function sessionAt(id: string, label: string, ...tsList: string[]): TimelineSession {
    return { id, label, models: [], events: tsList.map((ts) => ({ kind: "user", text: "x", ts })) };
  }
  const T = (hhmm: string) => `2026-06-01T${hhmm}:00.000Z`;
  const ids = (tracks: { id: string }[]) => tracks.map((t) => t.id);

  test("main を先頭固定し subagent を生存期間開始の古い順に並べる", () => {
    const tracks = buildTimelineTracks({
      main: sessionAt("main", "Main", T("09:00"), T("11:00")),
      plainSubagents: [sessionAt("late", "B", T("10:00")), sessionAt("early", "A", T("09:30"))],
      workflowGroups: [],
    });
    expect(ids(tracks)).toEqual(["main", "early", "late"]);
    expect(tracks[0].isMain).toBe(true);
    expect(tracks[0].startMs).toBe(Date.parse(T("09:00")));
  });

  test("ts を持たない subagent は末尾へ寄せる", () => {
    const tracks = buildTimelineTracks({
      main: undefined,
      plainSubagents: [sessionAt("noTs", "N"), sessionAt("withTs", "W", T("09:00"))],
      workflowGroups: [],
    });
    expect(ids(tracks)).toEqual(["withTs", "noTs"]);
  });

  test("workflow は見出し行 + 配下 agent (古い順) を 1 単位として contiguous に並べる", () => {
    const tracks = buildTimelineTracks({
      main: sessionAt("main", "Main", T("09:00")),
      plainSubagents: [],
      workflowGroups: [
        {
          name: "wf",
          runId: "wf_1",
          agents: [sessionAt("g2", "g2", T("09:30")), sessionAt("g1", "g1", T("09:10"))],
        },
      ],
    });
    expect(ids(tracks)).toEqual(["main", "wf_1", "g1", "g2"]);
    const header = tracks[1];
    expect(header.isHeader).toBe(true);
    expect(header.label).toBe("wf");
    expect(header.startMs).toBeUndefined();
    expect(tracks[2].indent).toBe(true);
  });

  test("plain と workflow を単位の最古開始時刻で混在ソートする", () => {
    const tracks = buildTimelineTracks({
      main: undefined,
      // plain は 10:00 開始、workflow は最古 agent が 09:00 開始 → workflow 単位が先。
      plainSubagents: [sessionAt("plain", "P", T("10:00"))],
      workflowGroups: [{ name: "wf", runId: "wf_1", agents: [sessionAt("a", "a", T("09:00"))] }],
    });
    expect(ids(tracks)).toEqual(["wf_1", "a", "plain"]);
  });

  test("全 agent が ts 不在の workflow 単位は末尾へ寄せる", () => {
    const tracks = buildTimelineTracks({
      main: undefined,
      plainSubagents: [sessionAt("plain", "P", T("09:00"))],
      workflowGroups: [{ name: "wf", runId: "wf_1", agents: [sessionAt("a", "a")] }],
    });
    expect(ids(tracks)).toEqual(["plain", "wf_1", "a"]);
  });
});

describe("timelineAxisRange", () => {
  const track = (startMs: number | undefined, endMs: number | undefined) => ({
    id: "x",
    label: "x",
    isMain: false,
    isHeader: false,
    indent: false,
    models: [],
    startMs,
    endMs,
  });

  test("有効 ts を持つトラックの min start / max end を返す", () => {
    expect(timelineAxisRange([track(30, 50), track(10, 40), track(undefined, undefined)])).toEqual({
      startMs: 10,
      endMs: 50,
    });
  });

  test("有効 ts を持つトラックが無ければ undefined", () => {
    expect(timelineAxisRange([])).toBeUndefined();
    expect(timelineAxisRange([track(undefined, undefined)])).toBeUndefined();
  });
});

describe("newestSubagentTrackId", () => {
  const track = (id: string, opts: { isMain?: boolean; isHeader?: boolean } = {}) => ({
    id,
    label: id,
    isMain: opts.isMain ?? false,
    isHeader: opts.isHeader ?? false,
    indent: false,
    models: [],
    startMs: undefined,
    endMs: undefined,
  });

  test("末尾から最初の非 header・非 main トラック id を返す", () => {
    const tracks = [
      track("main", { isMain: true }),
      track("wf_1", { isHeader: true }),
      track("a"),
      track("b"),
    ];
    expect(newestSubagentTrackId(tracks)).toBe("b");
  });

  test("subagent が無ければ undefined", () => {
    expect(newestSubagentTrackId([track("main", { isMain: true })])).toBeUndefined();
    expect(newestSubagentTrackId([])).toBeUndefined();
  });
});
describe("formatModelLabel", () => {
  test("既知 model を family + version に整形 (日付サフィックスは捨てる)", () => {
    expect(formatModelLabel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(formatModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(formatModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  test("既知パターンに合わない値は生のまま返す", () => {
    expect(formatModelLabel("gpt-4o")).toBe("gpt-4o");
    expect(formatModelLabel("claude-unknown")).toBe("claude-unknown");
  });
});
