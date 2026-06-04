import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import {
  buildSubagentLinks,
  formatSessionTime,
  nearestEventIndexByTs,
  parseSessionLog,
  sessionLogDirOf,
  type SubagentDescriptor,
  type TranscriptEvent,
} from "./sessionLog";

/** 1 レコードを JSONL 1 行にする。複数行は join して渡す。 */
function jsonl(...records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

const TS = "2026-05-31T10:00:00.000Z";

describe("parseSessionLog", () => {
  test("user の string content を user イベントにする", () => {
    const log = parseSessionLog(
      jsonl({ type: "user", timestamp: TS, message: { role: "user", content: "調べてほしい" } }),
    );
    expect(log.events).toEqual([{ kind: "user", text: "調べてほしい", ts: TS }]);
    expect(log.totalLines).toBe(1);
  });

  test("assistant の text / thinking を個別イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "考える", signature: "x" },
            { type: "text", text: "やります" },
          ],
        },
      }),
    );
    expect(log.events).toEqual([
      { kind: "thinking", text: "考える", ts: TS },
      { kind: "assistant", text: "やります", ts: TS },
    ]);
  });

  // signature は判定に使わない (平文の有無のみで決める)。fixture の signature は
  // 実ログ形状の再現であって判定には寄与しない。
  test("平文が空文字の thinking は載せず emptyThinking に計上 (skipped とは別枠)", () => {
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "encrypted-blob" },
            { type: "text", text: "やります" },
          ],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "assistant", text: "やります", ts: TS }]);
    expect(log.emptyThinking).toBe(1);
    expect(log.skipped).toBe(0);
  });

  test("thinking フィールド欠落 (signature のみ) も emptyThinking に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [{ type: "thinking", signature: "encrypted-blob" }],
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.emptyThinking).toBe(1);
  });

  test("空白のみの thinking は平文ありとみなし表示する (空判定は厳密一致)", () => {
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "  \n" }],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "thinking", text: "  \n", ts: TS }]);
    expect(log.emptyThinking).toBe(0);
  });

  test("空名 / 名前欠落の tool_use は可視マーカー (unnamed tool) に倒す", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "", input: {} }],
          },
        },
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t2", input: {} }],
          },
        },
      ),
    );
    const [empty, missing] = log.events;
    expect(empty?.kind === "tool" && empty.name).toBe("(unnamed tool)");
    expect(missing?.kind === "tool" && missing.name).toBe("(unnamed tool)");
  });

  test("input 欠落の tool_use は空 object に倒す (下流の添字アクセス保護)", () => {
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash" }],
        },
      }),
    );
    const tool = log.events[0];
    expect(tool?.kind === "tool" && tool.input).toEqual({});
  });

  test("tool_use と tool_result を tool_use_id でペア化する", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb", is_error: false }],
          },
        },
      ),
    );
    expect(log.events).toEqual([
      {
        kind: "tool",
        name: "Bash",
        input: { command: "ls" },
        toolUseId: "t1",
        ts: TS,
        result: { text: "a\nb", isError: false },
      },
    ]);
  });

  test("is_error の tool_result は result.isError=true", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
          },
        },
      ),
    );
    const tool = log.events[0];
    expect(tool?.kind === "tool" && tool.result).toEqual({ text: "boom", isError: true });
  });

  test("isMeta:true の user レコードは載せず skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        isMeta: true,
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "text", text: "Base directory for this skill" }],
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  test("slash command 起動はコマンド名を user イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content:
            "<command-message>review-pr</command-message>\n<command-name>/review-pr</command-name>",
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "user", text: "/review-pr", ts: TS }]);
    expect(log.skipped).toBe(0);
  });

  test("slash command の引数はコマンド名の後ろに連結する", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content:
            "<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>auto</command-args>",
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "user", text: "/effort auto", ts: TS }]);
    expect(log.skipped).toBe(0);
  });

  test("command-name を欠いた病的な command ブロックは載せず skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: { role: "user", content: "<command-message>broken</command-message>" },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  // command 抽出は先頭アンカー (COMMAND_BLOCK_LEAD_RE) で採否を決めるため、本文中に
  // <command-name> を含む生発話 (このログ機能自体を議論する発話など) は切り詰めず verbatim。
  test("本文中に <command-name> を含む通常発話は切り詰めず verbatim で残す", () => {
    const content = "この <command-name>/foo</command-name> の扱いを直して";
    const log = parseSessionLog(
      jsonl({ type: "user", timestamp: TS, message: { role: "user", content } }),
    );
    expect(log.events).toEqual([{ kind: "user", text: content, ts: TS }]);
    expect(log.skipped).toBe(0);
  });

  test("task-notification / system-reminder 注入 string は載せず skipped に計上", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          timestamp: TS,
          message: {
            role: "user",
            content: "<task-notification>\n<task-id>abc</task-id>\n<result>done</result>",
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: { role: "user", content: "<system-reminder>be careful</system-reminder>" },
        },
      ),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(2);
  });

  test("先頭が注入タグでない通常発話は残す (タグが後ろに付くケース)", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: "これを直して\n<system-reminder>noise</system-reminder>",
        },
      }),
    );
    expect(log.events).toEqual([
      { kind: "user", text: "これを直して\n<system-reminder>noise</system-reminder>", ts: TS },
    ]);
  });

  test("親 tool_use が無い tool_result は捨てて skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan" }],
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  test("attachment / system 等の非会話レコードは skipped に計上", () => {
    const log = parseSessionLog(
      jsonl(
        { type: "attachment", timestamp: TS },
        { type: "system", subtype: "turn_duration", timestamp: TS },
      ),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(2);
  });

  test("queued_command は commandMode:prompt の生発話を user イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "attachment",
        timestamp: TS,
        attachment: {
          type: "queued_command",
          prompt: "これ要らないなら消しとけ",
          commandMode: "prompt",
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "user", text: "これ要らないなら消しとけ", ts: TS }]);
    expect(log.skipped).toBe(0);
  });

  test("queued_command の commandMode:task-notification は載せず skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "attachment",
        timestamp: TS,
        attachment: {
          type: "queued_command",
          commandMode: "task-notification",
          prompt: "<task-notification>\n<task-id>abc</task-id>\n</task-notification>",
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  // commandMode を採否の SSOT にするため、本文がタグ始まりの正当な生発話 (<span> や
  // <command-name> を含む議論) を切り詰めず verbatim で出す。
  test("queued_command の commandMode:prompt はタグ始まりの本文も verbatim で出す", () => {
    const log = parseSessionLog(
      jsonl({
        type: "attachment",
        timestamp: TS,
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          prompt: '<span class="x">Setting up...</span> を消して',
        },
      }),
    );
    expect(log.events).toEqual([
      { kind: "user", text: '<span class="x">Setting up...</span> を消して', ts: TS },
    ]);
    expect(log.skipped).toBe(0);
  });

  test("parse 失敗行は malformed に計上し他行は継続処理", () => {
    const valid = JSON.stringify({
      type: "user",
      timestamp: TS,
      message: { role: "user", content: "ok" },
    });
    const log = parseSessionLog(`${valid}\n{ broken json`);
    expect(log.events).toEqual([{ kind: "user", text: "ok", ts: TS }]);
    expect(log.malformed).toBe(1);
    expect(log.totalLines).toBe(2);
  });

  test("base64 image block を data URL の image イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "image", ts: TS, src: "data:image/png;base64,AAAA" }]);
  });

  test("ホワイトリスト外 media_type の base64 image は src=undefined", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/svg+xml", data: "PHN2" },
            },
          ],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "image", ts: TS, src: undefined }]);
  });

  test("base64 でない image block は src=undefined", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "image", ts: TS, src: undefined }]);
  });

  test("未知の content block は events に載せず skipped に計上 (user / assistant 両方)", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "hi" },
              { type: "redacted_thinking", data: "xxx" },
            ],
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: { role: "user", content: [{ type: "future_block_type", foo: 1 }] },
        },
      ),
    );
    expect(log.events).toEqual([{ kind: "assistant", text: "hi", ts: TS }]);
    expect(log.skipped).toBe(2);
  });

  test("空行は totalLines に数えない", () => {
    const log = parseSessionLog("\n\n");
    expect(log.totalLines).toBe(0);
    expect(log.events).toEqual([]);
  });

  test("tool_result content が text/image 以外の block は可視マーカーにする", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "X", input: {} }],
          },
        },
        {
          type: "user",
          timestamp: TS,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [
                  { type: "text", text: "hi" },
                  { type: "image" },
                  { type: "tool_use", id: "nested", name: "Y", input: {} },
                ],
              },
            ],
          },
        },
      ),
    );
    const tool = log.events[0];
    expect(tool?.kind === "tool" && tool.result?.text).toBe("hi\n[image]\n[unsupported: tool_use]");
  });
});

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
  // tool event を 1 つ作る helper。toolUseId / name / input / result を指定する。
  function toolEvent(
    name: string,
    toolUseId: string,
    input: Record<string, unknown> = {},
    resultText?: string,
  ): TranscriptEvent {
    return {
      kind: "tool",
      name,
      input,
      toolUseId,
      ts: TS,
      result: resultText === undefined ? undefined : { text: resultText, isError: false },
    };
  }
  function sub(over: Partial<SubagentDescriptor>): SubagentDescriptor {
    return {
      id: "",
      label: "",
      name: "",
      parentToolUseId: "",
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

describe("sessionLogDirOf", () => {
  test("main jsonl の親 dir を返す", () => {
    const entries = [
      { kind: "main", path: "/Users/a/.claude/projects/enc/sid.jsonl" },
      { kind: "subagent", path: "/Users/a/.claude/projects/enc/sid/subagents/agent-x.jsonl" },
    ];
    expect(sessionLogDirOf(entries)).toBe("/Users/a/.claude/projects/enc");
  });

  test("main が無ければ先頭 entry の path を使う", () => {
    expect(sessionLogDirOf([{ kind: "subagent", path: "/a/b/agent-x.jsonl" }])).toBe("/a/b");
  });

  test("空配列は undefined", () => {
    expect(sessionLogDirOf([])).toBeUndefined();
  });

  test("path が空文字なら undefined", () => {
    expect(sessionLogDirOf([{ kind: "main", path: "" }])).toBeUndefined();
  });

  test("スラッシュを含まない path は undefined", () => {
    expect(sessionLogDirOf([{ kind: "main", path: "foo.jsonl" }])).toBeUndefined();
  });

  test("ルート直下 (slash が先頭) は undefined", () => {
    expect(sessionLogDirOf([{ kind: "main", path: "/foo.jsonl" }])).toBeUndefined();
  });
});
