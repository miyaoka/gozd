import { describe, expect, test } from "bun:test";
import { expandAskMessages, parseSessionLog, type TranscriptEvent } from "./sessionLog";

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

  test("rootPromptId は先頭レコードの promptId", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          timestamp: TS,
          promptId: "root-1",
          message: { role: "user", content: "hi" },
        },
        {
          type: "assistant",
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "yo" }] },
        },
      ),
    );
    expect(log.rootPromptId).toBe("root-1");
  });

  test("先頭レコードに promptId が無ければ rootPromptId は空文字", () => {
    const log = parseSessionLog(
      jsonl({ type: "user", timestamp: TS, message: { role: "user", content: "hi" } }),
    );
    expect(log.rootPromptId).toBe("");
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
        result: { text: "a\nb", isError: false, agentId: "", promptId: "" },
      },
    ]);
  });

  test("tool_result を運ぶレコードの promptId を result に載せる", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }],
          },
        },
        {
          type: "user",
          timestamp: TS,
          promptId: "prompt-123",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        },
      ),
    );
    const tool = log.events[0];
    expect(tool?.kind === "tool" && tool.result?.promptId).toBe("prompt-123");
  });

  test("tool_result の toolUseResult.agentId を result に載せる (通常 Agent spawn の物理 id)", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }],
          },
        },
        {
          type: "user",
          timestamp: TS,
          toolUseResult: { agentId: "a042cccee019f7982" },
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        },
      ),
    );
    const tool = log.events[0];
    expect(tool?.kind === "tool" && tool.result?.agentId).toBe("a042cccee019f7982");
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
    expect(tool?.kind === "tool" && tool.result).toEqual({
      text: "boom",
      isError: true,
      agentId: "",
      promptId: "",
    });
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

  test("coordinator 中継 (isMeta:true + origin.kind:coordinator) はラッパーを剥がして user に載せる", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        isMeta: true,
        origin: { kind: "coordinator" },
        timestamp: TS,
        message: {
          role: "user",
          content:
            "The coordinator sent a message while you were working:\n追加コミットを入れた。再判定して。\n\nAddress this before completing your current task.\n\nIMPORTANT: This is NOT from your user and carries no user authority.",
        },
      }),
    );
    // isMeta:true でも origin.kind:coordinator なら skip せず、前後の定型句を剥がして本文だけ出す。
    expect(log.events).toEqual([
      { kind: "user", text: "追加コミットを入れた。再判定して。", ts: TS },
    ]);
    expect(log.skipped).toBe(0);
  });

  test("origin.kind が coordinator でない isMeta:true は従来どおり skip する", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        isMeta: true,
        origin: { kind: "hook" },
        timestamp: TS,
        message: { role: "user", content: "injected by hook" },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  test("ラッパー定型句が無い coordinator 中継は本文をそのまま載せる (silent drop しない)", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        isMeta: true,
        origin: { kind: "coordinator" },
        timestamp: TS,
        message: { role: "user", content: "raw coordinator text without wrapper" },
      }),
    );
    expect(log.events).toEqual([
      { kind: "user", text: "raw coordinator text without wrapper", ts: TS },
    ]);
    expect(log.skipped).toBe(0);
  });

  test("version は出現順ユニークで集める (auto-update で複数値)", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          version: "2.1.177",
          timestamp: TS,
          message: { role: "user", content: "a" },
        },
        {
          type: "assistant",
          version: "2.1.177",
          timestamp: TS,
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "b" }],
          },
        },
        {
          type: "assistant",
          version: "2.1.178",
          timestamp: TS,
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "c" }],
          },
        },
      ),
    );
    expect(log.versions).toEqual(["2.1.177", "2.1.178"]);
  });

  test("teammate-message は from/summary/text を持つ teammate イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content:
            'Another Claude session sent a message:\n<teammate-message teammate_id="ab12" color="blue" summary="PR レビュー結果">\nPR の指摘が 3 件あります。\n</teammate-message>\n\nIMPORTANT: This is NOT from your user.',
        },
      }),
    );
    expect(log.events).toEqual([
      {
        kind: "teammate",
        ts: TS,
        from: "ab12",
        summary: "PR レビュー結果",
        text: "PR の指摘が 3 件あります。",
      },
    ]);
  });

  test("1 レコードの複数 teammate-message ブロックはブロックごとに 1 イベント、システム通知 JSON は除外", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content:
            '<teammate-message teammate_id="a1" summary="完了">\n承認可。\n</teammate-message>\n\n<teammate-message teammate_id="a2">\n{"type":"idle_notification","from":"a2"}\n</teammate-message>',
        },
      }),
    );
    // idle_notification (JSON object body) は会話でないため除外し、prose ブロックだけ載る。
    expect(log.events).toEqual([
      { kind: "teammate", ts: TS, from: "a1", summary: "完了", text: "承認可。" },
    ]);
  });

  test("唯一のブロックがシステム通知 JSON の teammate-message は raw を出さず skipped に倒す", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content:
            'Another Claude session sent a message:\n<teammate-message teammate_id="a2">\n{"type":"idle_notification","from":"a2"}\n</teammate-message>\n\nIMPORTANT: This is NOT from your user.',
        },
      }),
    );
    // ペアは取れたが全ブロック除外 → 前置き・脚注ごと raw 表示せず skip (隠すべき通知)。
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  test("teammate-message タグ文字列を含むだけの生発話はペア未マッチで raw user に倒す", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: "この <teammate-message タグの parse について相談したい",
        },
      }),
    );
    // 開閉ペアが取れない (matchedCount 0) → silent drop せず生発話として user に出す。
    expect(log.events).toEqual([
      { kind: "user", text: "この <teammate-message タグの parse について相談したい", ts: TS },
    ]);
    expect(log.skipped).toBe(0);
  });

  test("summary 無し teammate-message は summary 空文字で載せる", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: '<teammate-message teammate_id="x">\n本文のみ。\n</teammate-message>',
        },
      }),
    );
    expect(log.events).toEqual([
      { kind: "teammate", ts: TS, from: "x", summary: "", text: "本文のみ。" },
    ]);
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

  test("task-notification 注入 string は載せず skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: {
          role: "user",
          content: "<task-notification>\n<task-id>abc</task-id>\n<result>done</result>",
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  test("system-reminder 注入 string は開閉タグを剥がして system イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: { role: "user", content: "<system-reminder>be careful</system-reminder>" },
      }),
    );
    expect(log.events).toEqual([
      { kind: "system", label: "system-reminder", text: "be careful", ts: TS },
    ]);
    expect(log.skipped).toBe(0);
  });

  test("閉じタグ欠落の system-reminder は先頭タグだけ剥がして全文を残す", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: { role: "user", content: "<system-reminder>truncated body" },
      }),
    );
    expect(log.events).toEqual([
      { kind: "system", label: "system-reminder", text: "truncated body", ts: TS },
    ]);
  });

  test("本文が空の system-reminder は載せず skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "user",
        timestamp: TS,
        message: { role: "user", content: "<system-reminder> </system-reminder>" },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
  });

  test("hook_success attachment の非空 content は system イベントにする", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "attachment",
          timestamp: TS,
          attachment: {
            type: "hook_success",
            hookName: "SessionStart:startup",
            hookEvent: "SessionStart",
            content: "このセッションのルートは /path/to/worktree です。",
          },
        },
        // content 空の hook_success (発火記録のみ) は表示する中身が無いため skipped。
        {
          type: "attachment",
          timestamp: TS,
          attachment: {
            type: "hook_success",
            hookName: "PreToolUse:Bash",
            hookEvent: "PreToolUse",
            content: "",
          },
        },
      ),
    );
    expect(log.events).toEqual([
      {
        kind: "system",
        label: "SessionStart:startup",
        text: "このセッションのルートは /path/to/worktree です。",
        ts: TS,
      },
    ]);
    expect(log.skipped).toBe(1);
  });

  test("hook_additional_context attachment は非空 string 要素を結合して system イベントにする", () => {
    const log = parseSessionLog(
      jsonl({
        type: "attachment",
        timestamp: TS,
        attachment: {
          type: "hook_additional_context",
          hookName: "PreToolUse:Bash",
          hookEvent: "PreToolUse",
          content: ["node_modules を直接読むな", "", "ghq skill を使え"],
        },
      }),
    );
    expect(log.events).toEqual([
      {
        kind: "system",
        label: "PreToolUse:Bash",
        text: "node_modules を直接読むな\nghq skill を使え",
        ts: TS,
      },
    ]);
    expect(log.skipped).toBe(0);
  });

  test("hookName 欠落の hook attachment は label を hook に倒す", () => {
    const log = parseSessionLog(
      jsonl({
        type: "attachment",
        timestamp: TS,
        attachment: { type: "hook_success", content: "injected" },
      }),
    );
    expect(log.events).toEqual([{ kind: "system", label: "hook", text: "injected", ts: TS }]);
  });

  test("SDK 合成 assistant (model:<synthetic>) は transcript に載せず skipped に計上", () => {
    // 観測形: 実 assistant 応答後に SDK が `model:"<synthetic>"` + `[{type:"text",text:"No response requested."}]`
    // を同じ親に追記する。これは実応答ではないので skipped に倒す。
    const log = parseSessionLog(
      jsonl({
        type: "assistant",
        timestamp: TS,
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
        },
      }),
    );
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
    expect(log.models).toEqual([]);
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

  // 画像添付つきで queue に積むと prompt は string でなく ContentBlock[] (text + image) になる。
  // string と決め打ちして配列を text に push すると base64 が生露出する。message.content と同じく
  // text → user / image → image に分離する。
  test("queued_command の prompt が配列なら text/image を分離する", () => {
    const log = parseSessionLog(
      jsonl({
        type: "attachment",
        timestamp: TS,
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          prompt: [
            { type: "text", text: "これ見て\n[Image #1]" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      }),
    );
    expect(log.events).toEqual([
      { kind: "user", text: "これ見て\n[Image #1]", ts: TS },
      { kind: "image", ts: TS, source: { mediaType: "image/png", base64: "AAAA" } },
    ]);
    expect(log.skipped).toBe(0);
  });

  // 配列 prompt 内の未知 block は無言で落とさず skipped に計上する。この skipped 計上は
  // userArrayBlockEvent (helper) ではなく queued_command 配列ループ側の固有コードなので、
  // 通常 user 経路の既存テストでは踏まれず独立に検証する必要がある。
  test("queued_command の配列 prompt 内の未知 block は skipped に計上", () => {
    const log = parseSessionLog(
      jsonl({
        type: "attachment",
        timestamp: TS,
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          prompt: [
            { type: "text", text: "ここだけ拾う" },
            { type: "future_block_type", foo: 1 },
          ],
        },
      }),
    );
    expect(log.events).toEqual([{ kind: "user", text: "ここだけ拾う", ts: TS }]);
    expect(log.skipped).toBe(1);
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
    // totalLines は表示した (live な) 行数。parse 不能行は uuid 不明で枝に帰属できないため
    // malformed に計上して totalLines からは外す (= live 1 行のみ)。
    expect(log.totalLines).toBe(1);
  });

  // rewind 分岐: assistant 応答 (a1) を親に user プロンプトが 2 つ (旧 b1 / 新 b2) 生える。
  // append-only なので b2 が最新。デフォルトは最新枝 (b2) を表示し、その直前に branch を挿す。
  const rewindLog = () =>
    jsonl(
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: TS,
        message: { role: "user", content: "?" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text: "どうぞ" }] },
      },
      // 旧枝 (rewind で捨てられた)
      {
        type: "user",
        uuid: "b1",
        parentUuid: "a1",
        timestamp: TS,
        message: { role: "user", content: "週末の天気は？" },
      },
      {
        type: "assistant",
        uuid: "c1",
        parentUuid: "b1",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text: "週末は雨" }] },
      },
      // 新枝 (最新)
      {
        type: "user",
        uuid: "b2",
        parentUuid: "a1",
        timestamp: TS,
        message: { role: "user", content: "昨日の天気は？" },
      },
      {
        type: "assistant",
        uuid: "c2",
        parentUuid: "b2",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text: "昨日は晴れ" }] },
      },
    );

  // 観測症状: 実 assistant 応答 (b1) と SDK 合成 assistant (b2: model:<synthetic>) が同じ親 uuid に
  // 並ぶ。append-only 木の上では兄弟になるが、合成 assistant は rewind ではないため branch chooser
  // を出してはいけない (ターミナル上では分岐していないのに UI 上だけ分岐表示される症状)。
  test("rewind: SDK 合成 assistant は分岐候補から除外する", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "主要箇所の検証お願い" },
        },
        {
          type: "assistant",
          uuid: "b1",
          parentUuid: "u1",
          timestamp: TS,
          message: {
            role: "assistant",
            model: "claude-opus-4-7",
            content: [{ type: "text", text: "主要箇所の検証が完了しました。" }],
          },
        },
        {
          type: "assistant",
          uuid: "b2",
          parentUuid: "u1",
          timestamp: TS,
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "No response requested." }],
          },
        },
      ),
    );
    expect(log.events).toEqual([
      { kind: "user", text: "主要箇所の検証お願い", ts: TS },
      { kind: "assistant", text: "主要箇所の検証が完了しました。", ts: TS },
    ]);
  });

  // 実観測形 (studio-front jsonl) を再現する fixture builder。AskUserQuestion 投げた直後にセッション
  // が切れ `claude --continue` 相当で resume されたケース。木の形:
  //
  //   u1 (user 生発話, candidate)
  //     ├─ a0 (assistant thinking; 最新モデルは signature のみで平文は空 → NOT candidate)
  //     │   └─ a1 (assistant text "主要箇所…", candidate)
  //     │       └─ a2 (assistant tool_use:AskUserQuestion, NOT candidate; ここで停止)
  //     └─ r1 (user "Continue from where you left off.", isMeta:true → NOT candidate)
  //         └─ r2 (assistant text "No response requested.", model = r2Model)
  //
  // 症状の消失は「r1 を弾く isMeta filter (既存) と r2 を弾く synthetic filter (本 PR で追加)」の AND
  // で初めて成立する。どちらが欠けても a1 と r2 (または r1) が `convAncestor` で u1 兄弟になり偽
  // branch chooser が浮上する。model フィールドだけ差し替えれば「synthetic filter on/off」を切り替え
  // られる作りにし、positive / contrast の 2 test で同 topology を比較する。
  const resumeMidAskFixture = (r2Model: string) =>
    jsonl(
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: TS,
        message: { role: "user", content: "投稿予定の総評本文をレビュー" },
      },
      // real chain
      {
        type: "assistant",
        uuid: "a0",
        parentUuid: "u1",
        timestamp: TS,
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "thinking", thinking: "", signature: "redacted" }],
        },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "a0",
        timestamp: TS,
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "主要箇所の検証が完了しました。" }],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "a1",
        timestamp: TS,
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          content: [{ type: "tool_use", id: "tu1", name: "AskUserQuestion", input: {} }],
        },
      },
      // resume chain: r1 は SDK 注入 (isMeta:true)、r2 が問題の synthetic
      {
        type: "user",
        uuid: "r1",
        parentUuid: "u1",
        isMeta: true,
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "text", text: "Continue from where you left off." }],
        },
      },
      {
        type: "assistant",
        uuid: "r2",
        parentUuid: "r1",
        timestamp: TS,
        message: {
          role: "assistant",
          model: r2Model,
          content: [{ type: "text", text: "No response requested." }],
        },
      },
    );

  // positive (synthetic) と contrast (実モデル) を pair で並べる。両 test は同じ topology で
  // model フィールドだけが違う。positive が本 PR の core invariant (偽 chooser 消滅) を assert し、
  // contrast は `isBranchCandidate` の synthetic 早期 return が外された場合に得られる挙動を
  // ロックして退行検出を担保する。
  //
  // contrast の expect 値は「現状の正しい挙動の spec」ではなく「本 PR で消したい症状を退行検出
  // のためにロックしているもの」。将来 resume 注入 user prompt 自体の扱いを変える等 core を深める
  // 変更を入れる際は、contrast の expect を更新する前提。
  //
  // 両 test は events だけでなく skipped / emptyThinking / models も assert することで、synthetic
  // 弾きが外れた退行時に「skipped が 2 → 1 に減る」「models[] への重複登録の有無」等の二次的な
  // 副作用も検出する。
  describe("rewind: resume mid-AskUserQuestion synthetic exclusion (regression guard pair)", () => {
    test("positive: model:<synthetic> の r2 は branch 候補から外れ偽 chooser が消える", () => {
      const log = parseSessionLog(resumeMidAskFixture("<synthetic>"));
      // AskUserQuestion は tool ではなく ask イベントとして emit される。input.questions が
      // 空 (この fixture では `input: {}`) のときも ask を作り、questions:[] のまま残す
      // (resume 中断 + 質問配列空 = 最も degenerate な ask シナリオの表現)。
      expect(log.events).toEqual([
        { kind: "user", text: "投稿予定の総評本文をレビュー", ts: TS },
        { kind: "assistant", text: "主要箇所の検証が完了しました。", ts: TS },
        {
          kind: "ask",
          ts: TS,
          toolUseId: "tu1",
          questions: [],
        },
      ]);
      // r1 (isMeta) + r2 (synthetic) が skipped に計上される。a0 の空 thinking は emptyThinking 側。
      expect(log.skipped).toBe(2);
      expect(log.emptyThinking).toBe(1);
      expect(log.models).toEqual(["claude-opus-4-7"]);
    });

    // contrast: `isBranchCandidate` の synthetic 早期 return line を外すと positive の expect
    // 結果がこの contrast 形 (偽 branch chooser 出現) に変わる。退行検出担保。
    test("contrast: r2 が実モデルだと同じ topology で偽 chooser が浮上する", () => {
      const log = parseSessionLog(resumeMidAskFixture("claude-opus-4-7"));
      expect(log.events).toEqual([
        { kind: "user", text: "投稿予定の総評本文をレビュー", ts: TS },
        {
          kind: "branch",
          ts: TS,
          branchKey: "u1",
          selectedChildUuid: "r2",
          options: [
            { childUuid: "a1", index: 1, lead: "主要箇所の検証が完了しました。", ts: TS },
            { childUuid: "r2", index: 2, lead: "No response requested.", ts: TS },
          ],
        },
        { kind: "assistant", text: "No response requested.", ts: TS },
      ]);
      // r1 (isMeta) のみ skipped。r2 は synthetic 弾きが効かないため events に乗り skipped されない。
      // 分岐確定により a1 / a2 サブツリーは prune される (a0 は分岐より上なので emptyThinking に残る)。
      expect(log.skipped).toBe(1);
      expect(log.emptyThinking).toBe(1);
      expect(log.models).toEqual(["claude-opus-4-7"]);
    });
  });

  describe("AskUserQuestion を ask イベントに畳む", () => {
    // AskUserQuestion は assistant の質問 + user の回答を 1 つの会話ブロックに畳んで扱う。
    // tool_use の input.questions[] から質問列と選択肢を抜き、後続の tool_result が来た line
    // の raw top-level `toolUseResult.answers` (構造化 Map) から answer を充填する。result が
    // 来ない (resume 中断) ケースは answer=undefined のまま残す。
    //
    // 充填ソースに `toolUseResult.answers` を使う理由: 同 line に同居する tool_result.content
    // の自然言語テキスト ("Q"="A" 形式) は質問・回答が `"` を含むと regex 復元が壊れる。
    // `answers` は Claude Code が組み立てた構造化 Map なので、信頼境界外データの任意 char
    // 集合に依存せず正しく取れる。

    /**
     * AskUserQuestion 応答 line の最小 fixture。message.content には tool_result block を、
     * top-level `toolUseResult.answers` には Q→A Map を載せる (実 jsonl の構造と一致)。
     */
    const askResultLine = (
      toolUseId: string,
      answers: Record<string, string> | undefined,
    ): unknown => ({
      type: "user",
      timestamp: TS,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: "Your questions have been answered: ... (text 経路は読まない)",
          },
        ],
      },
      ...(answers !== undefined ? { toolUseResult: { answers } } : {}),
    });

    test("通常の Q/A: input から質問列を構築し toolUseResult.answers から answer を充填", () => {
      const log = parseSessionLog(
        jsonl(
          {
            type: "assistant",
            timestamp: TS,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tu1",
                  name: "AskUserQuestion",
                  input: {
                    questions: [
                      {
                        question: "日本の首都はどこ?",
                        header: "日本クイズ",
                        multiSelect: false,
                        options: [
                          { label: "京都", description: "古都" },
                          { label: "東京", description: "現首都" },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          },
          askResultLine("tu1", { "日本の首都はどこ?": "東京" }),
        ),
      );
      expect(log.events).toEqual([
        {
          kind: "ask",
          ts: TS,
          toolUseId: "tu1",
          questions: [
            {
              question: "日本の首都はどこ?",
              header: "日本クイズ",
              multiSelect: false,
              options: [
                { label: "京都", description: "古都" },
                { label: "東京", description: "現首都" },
              ],
              answer: "東京",
            },
          ],
        },
      ]);
    });

    test("複数 question: 各 answer を question 文字列で引き当てる", () => {
      const log = parseSessionLog(
        jsonl(
          {
            type: "assistant",
            timestamp: TS,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tu1",
                  name: "AskUserQuestion",
                  input: {
                    questions: [
                      { question: "Q1", header: "", multiSelect: false, options: [] },
                      { question: "Q2", header: "", multiSelect: false, options: [] },
                    ],
                  },
                },
              ],
            },
          },
          askResultLine("tu1", { Q1: "A1", Q2: "A2" }),
        ),
      );
      const ev = log.events[0];
      expect(ev?.kind).toBe("ask");
      if (ev?.kind === "ask") {
        expect(ev.questions.map((q) => q.answer)).toEqual(["A1", "A2"]);
      }
    });

    // 上流の構造化 Map を SSOT に使うため、質問・回答内部の `"` が信頼境界外データとして
    // 来ても壊れないこと。content text 経路を regex で復元すると `What is "foo"?` のような
    // 形で `?` だけが抽出される等の破綻ケースがあったが、`toolUseResult.answers` 経路に
    // 倒したことで任意 char 集合に依存しない。
    test('質問 / 回答に `"` を含んでも構造化 answers Map で正しく取れる', () => {
      const tricky = 'What is "foo"?';
      const trickyAnswer = 'answer with "quote"';
      const log = parseSessionLog(
        jsonl(
          {
            type: "assistant",
            timestamp: TS,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tu1",
                  name: "AskUserQuestion",
                  input: {
                    questions: [{ question: tricky, header: "", multiSelect: false, options: [] }],
                  },
                },
              ],
            },
          },
          askResultLine("tu1", { [tricky]: trickyAnswer }),
        ),
      );
      const ev = log.events[0];
      expect(ev?.kind).toBe("ask");
      if (ev?.kind === "ask") {
        expect(ev.questions[0]?.answer).toBe(trickyAnswer);
      }
    });

    test("result が無い (resume 中断) と answer は undefined のまま", () => {
      const log = parseSessionLog(
        jsonl({
          type: "assistant",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tu1",
                name: "AskUserQuestion",
                input: {
                  questions: [
                    {
                      question: "このまま投稿しますか?",
                      header: "次のステップ",
                      multiSelect: false,
                      options: [{ label: "このまま投稿", description: "修正なし" }],
                    },
                  ],
                },
              },
            ],
          },
        }),
      );
      const ev = log.events[0];
      expect(ev?.kind).toBe("ask");
      if (ev?.kind === "ask") {
        expect(ev.questions[0]?.answer).toBeUndefined();
        expect(ev.questions[0]?.options).toEqual([
          { label: "このまま投稿", description: "修正なし" },
        ]);
      }
    });

    // parser invariant: 「未充填」概念を `q.answer === undefined` の 1 条件に閉じる
    // (consumer の if 分岐 SSOT 化)。Claude Code 仕様上空文字 answer は通常発生しないが、
    // 信頼境界外データとして来た場合に dialog の `v-if="q.answer !== undefined"` が
    // 空緑バブルを出す症状を parser 側で消す。
    test("空文字 answer は未充填扱いで undefined に倒される (SSOT)", () => {
      const log = parseSessionLog(
        jsonl(
          {
            type: "assistant",
            timestamp: TS,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tu1",
                  name: "AskUserQuestion",
                  input: {
                    questions: [{ question: "Q1", header: "", multiSelect: false, options: [] }],
                  },
                },
              ],
            },
          },
          askResultLine("tu1", { Q1: "" }),
        ),
      );
      const ev = log.events[0];
      expect(ev?.kind).toBe("ask");
      if (ev?.kind === "ask") {
        expect(ev.questions[0]?.answer).toBeUndefined();
      }
    });

    // tool_result が来たが構造化 `answers` フィールドが欠落しているケース (信頼境界外
    // で起こり得る部分破損)。text 経路 fallback は持たないため `answer === undefined`
    // のままで描画側が「(no response)」を出す。silent drop ではなく可視化される。
    test("toolUseResult.answers が欠落していると answer は undefined のまま", () => {
      const log = parseSessionLog(
        jsonl(
          {
            type: "assistant",
            timestamp: TS,
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tu1",
                  name: "AskUserQuestion",
                  input: {
                    questions: [{ question: "Q1", header: "", multiSelect: false, options: [] }],
                  },
                },
              ],
            },
          },
          askResultLine("tu1", undefined),
        ),
      );
      const ev = log.events[0];
      expect(ev?.kind).toBe("ask");
      if (ev?.kind === "ask") {
        expect(ev.questions[0]?.answer).toBeUndefined();
      }
    });
  });

  describe("expandAskMessages", () => {
    test("ask を assistant (質問) と user (回答) に inline 展開し、他 kind は透過", () => {
      const events: TranscriptEvent[] = [
        { kind: "user", text: "始めて", ts: TS },
        { kind: "thinking", text: "考え中", ts: TS },
        {
          kind: "ask",
          ts: TS,
          toolUseId: "tu1",
          questions: [
            { question: "Q1", header: "", multiSelect: false, options: [], answer: "A1" },
            { question: "Q2", header: "", multiSelect: false, options: [], answer: undefined },
          ],
        },
        { kind: "assistant", text: "おわり", ts: TS },
      ];
      // ask は (Q1 → A1) + (Q2 のみ, A2 は undefined で欠落)、thinking / assistant は素通し。
      expect(expandAskMessages(events)).toEqual([
        { kind: "user", text: "始めて", ts: TS },
        { kind: "thinking", text: "考え中", ts: TS },
        { kind: "assistant", text: "Q1", ts: TS },
        { kind: "user", text: "A1", ts: TS },
        { kind: "assistant", text: "Q2", ts: TS },
        { kind: "assistant", text: "おわり", ts: TS },
      ]);
    });

    test("空 question は質問メッセージを出さない (表示できる本文無しは bubble に倒さない)", () => {
      expect(
        expandAskMessages([
          {
            kind: "ask",
            ts: TS,
            toolUseId: "tu1",
            questions: [{ question: "", header: "", multiSelect: false, options: [], answer: "A" }],
          },
        ]),
      ).toEqual([{ kind: "user", text: "A", ts: TS }]);
    });

    // 「空文字 answer は未充填扱い」は parser 側で `answer = undefined` に正規化する
    // invariant で SSOT 化済み (parseSessionLog 「空文字 answer は未充填扱いで undefined に
    // 倒される」test 参照)。consumer (expandAskMessages / dialog) は `q.answer === undefined`
    // の 1 条件だけで未充填判定するため、`expandAskMessages` 側に空文字 answer の独立
    // 仕様 test は持たない (parser invariant を信頼できなくなる二重定義になる)。

    test("空入力は空出力", () => {
      expect(expandAskMessages([])).toEqual([]);
    });

    test("ask 不在の入力はそのまま透過する", () => {
      const events: TranscriptEvent[] = [
        { kind: "user", text: "u", ts: TS },
        { kind: "assistant", text: "a", ts: TS },
        { kind: "thinking", text: "t", ts: TS },
      ];
      expect(expandAskMessages(events)).toEqual(events);
    });
  });

  test("rewind: デフォルトは最新枝を表示し直前に branch セレクタを挿す (捨て枝は出さない)", () => {
    const log = parseSessionLog(rewindLog());
    expect(log.events).toEqual([
      { kind: "user", text: "?", ts: TS },
      { kind: "assistant", text: "どうぞ", ts: TS },
      {
        kind: "branch",
        ts: TS,
        branchKey: "a1",
        selectedChildUuid: "b2",
        options: [
          { childUuid: "b1", index: 1, lead: "週末の天気は？", ts: TS },
          { childUuid: "b2", index: 2, lead: "昨日の天気は？", ts: TS },
        ],
      },
      { kind: "user", text: "昨日の天気は？", ts: TS },
      { kind: "assistant", text: "昨日は晴れ", ts: TS },
    ]);
  });

  test("rewind: teammate 枝の lead は 3 分岐で出し分ける (summary / 全ブロック除外は空 / 非タグ生発話は raw)", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "?" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "どうぞ" }] },
        },
        // 枝1: 通常の teammate-message (summary あり) → lead は summary
        {
          type: "user",
          uuid: "b1",
          parentUuid: "a1",
          timestamp: TS,
          message: {
            role: "user",
            content:
              '<teammate-message teammate_id="x" summary="完了">\n承認可。\n</teammate-message>',
          },
        },
        // 枝2: idle_notification 単独 (全ブロック除外) → lead は空文字 (raw を漏らさない)
        {
          type: "user",
          uuid: "b2",
          parentUuid: "a1",
          timestamp: TS,
          message: {
            role: "user",
            content:
              '<teammate-message teammate_id="y">\n{"type":"idle_notification"}\n</teammate-message>',
          },
        },
        // 枝3 (最新): <teammate-message 文字列を含むだけの生発話 (ペア未マッチ) → lead は raw
        {
          type: "user",
          uuid: "b3",
          parentUuid: "a1",
          timestamp: TS,
          message: { role: "user", content: "この <teammate-message を相談したい" },
        },
      ),
    );
    const branch = log.events.find((e) => e.kind === "branch");
    if (branch?.kind !== "branch") throw new Error("branch event not found");
    expect(branch.options).toEqual([
      { childUuid: "b1", index: 1, lead: "完了", ts: TS },
      { childUuid: "b2", index: 2, lead: "", ts: TS },
      { childUuid: "b3", index: 3, lead: "この <teammate-message を相談したい", ts: TS },
    ]);
  });

  test("rewind: selection で旧枝を選ぶとその枝に差し替わる", () => {
    const log = parseSessionLog(rewindLog(), new Map([["a1", "b1"]]));
    expect(log.events).toEqual([
      { kind: "user", text: "?", ts: TS },
      { kind: "assistant", text: "どうぞ", ts: TS },
      {
        kind: "branch",
        ts: TS,
        branchKey: "a1",
        selectedChildUuid: "b1",
        options: [
          { childUuid: "b1", index: 1, lead: "週末の天気は？", ts: TS },
          { childUuid: "b2", index: 2, lead: "昨日の天気は？", ts: TS },
        ],
      },
      { kind: "user", text: "週末の天気は？", ts: TS },
      { kind: "assistant", text: "週末は雨", ts: TS },
    ]);
  });

  test("rewind: 存在しない childUuid 指定は最新枝にフォールバック", () => {
    const log = parseSessionLog(rewindLog(), new Map([["a1", "nonexistent"]]));
    const userTexts = log.events.filter((e) => e.kind === "user").map((e) => e.text);
    expect(userTexts).toEqual(["?", "昨日の天気は？"]);
  });

  test("rewind 無し (uuid の 1 本道) は全件表示で branch を挿さない", () => {
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "やあ" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "こんにちは" }] },
        },
      ),
    );
    expect(log.events).toEqual([
      { kind: "user", text: "やあ", ts: TS },
      { kind: "assistant", text: "こんにちは", ts: TS },
    ]);
  });

  test("rewind: 分岐の親が透過ノード (system) でも会話的親 (直前の assistant) を branchKey にする", () => {
    // 実ログ形: user → assistant → system → system → user×2。turn 境界の system を透過して
    // 会話的親 a1 を branchKey に解決できることを踏む。間の system は表示されず (skipped)。
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "?" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "どうぞ" }] },
        },
        { type: "system", uuid: "s1", parentUuid: "a1", timestamp: TS },
        { type: "system", uuid: "s2", parentUuid: "s1", timestamp: TS },
        {
          type: "user",
          uuid: "b1",
          parentUuid: "s2",
          timestamp: TS,
          message: { role: "user", content: "週末の天気は？" },
        },
        {
          type: "user",
          uuid: "b2",
          parentUuid: "s2",
          timestamp: TS,
          message: { role: "user", content: "昨日の天気は？" },
        },
      ),
    );
    expect(log.events).toEqual([
      { kind: "user", text: "?", ts: TS },
      { kind: "assistant", text: "どうぞ", ts: TS },
      {
        kind: "branch",
        ts: TS,
        branchKey: "a1",
        selectedChildUuid: "b2",
        options: [
          { childUuid: "b1", index: 1, lead: "週末の天気は？", ts: TS },
          { childUuid: "b2", index: 2, lead: "昨日の天気は？", ts: TS },
        ],
      },
      { kind: "user", text: "昨日の天気は？", ts: TS },
    ]);
  });

  test("rewind: 2 つの prompt の直接親が異なっても (attachment vs system) 会話的親で 1 分岐に束ねる", () => {
    // 実ログ形 (05b08da3): assistant 応答後に rewind した 2 つの prompt が、一方は attachment、
    // 他方は system を直接親に持ち、直接 parentUuid は異なる。会話的親 a1 で束ねないと分岐が
    // 検出されず両 prompt が表示される (= 旧枝混入。本 PR が直す症状の再発)。
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "?" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "どうぞ" }] },
        },
        // 旧枝: prompt b1 の直接親は attachment
        { type: "attachment", uuid: "att1", parentUuid: "a1", timestamp: TS },
        {
          type: "user",
          uuid: "b1",
          parentUuid: "att1",
          timestamp: TS,
          message: { role: "user", content: "旧" },
        },
        // 新枝: prompt b2 の直接親は system
        { type: "system", uuid: "sys1", parentUuid: "a1", timestamp: TS },
        {
          type: "user",
          uuid: "b2",
          parentUuid: "sys1",
          timestamp: TS,
          message: { role: "user", content: "新" },
        },
      ),
    );
    const branches = log.events.filter((e) => e.kind === "branch");
    expect(branches).toEqual([
      {
        kind: "branch",
        ts: TS,
        branchKey: "a1",
        selectedChildUuid: "b2",
        options: [
          { childUuid: "b1", index: 1, lead: "旧", ts: TS },
          { childUuid: "b2", index: 2, lead: "新", ts: TS },
        ],
      },
    ]);
    // 旧枝 b1 は表示されず、新枝 b2 のみ。
    const userTexts = log.events.filter((e) => e.kind === "user").map((e) => e.text);
    expect(userTexts).toEqual(["?", "新"]);
  });

  test("並列 tool 呼び出しは分岐にならず全 tool を表示する (偽分岐の回帰防止)", () => {
    // 実ログ形: 1 ターンで 2 tool を呼ぶと tool_use t1 が「次の tool_use t2」と「自身の
    // tool_result r1」の 2 子を持つ。これは rewind ではない。子 2 つを分岐とみなすと本流
    // (t2 以降) を捨て枝として落とすため、tool_use / tool_result は分岐候補から外す。
    const log = parseSessionLog(
      jsonl(
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: TS,
          message: { role: "user", content: "調べて" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
          },
        },
        {
          type: "assistant",
          uuid: "a2",
          parentUuid: "a1",
          timestamp: TS,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t2", name: "Read", input: { file: "x" } }],
          },
        },
        {
          type: "user",
          uuid: "r1",
          parentUuid: "a1",
          timestamp: TS,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "out1" }],
          },
        },
        {
          type: "user",
          uuid: "r2",
          parentUuid: "a2",
          timestamp: TS,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t2", content: "out2" }],
          },
        },
        {
          type: "assistant",
          uuid: "a3",
          parentUuid: "r2",
          timestamp: TS,
          message: { role: "assistant", content: [{ type: "text", text: "終わり" }] },
        },
      ),
    );
    // 分岐は発生しない。両 tool が結果付きで表示され、本流の text も残る。
    expect(log.events.some((e) => e.kind === "branch")).toBe(false);
    expect(log.events).toEqual([
      { kind: "user", text: "調べて", ts: TS },
      {
        kind: "tool",
        name: "Bash",
        input: { command: "ls" },
        toolUseId: "t1",
        ts: TS,
        result: { text: "out1", isError: false, agentId: "", promptId: "" },
      },
      {
        kind: "tool",
        name: "Read",
        input: { file: "x" },
        toolUseId: "t2",
        ts: TS,
        result: { text: "out2", isError: false, agentId: "", promptId: "" },
      },
      { kind: "assistant", text: "終わり", ts: TS },
    ]);
  });

  // ネスト分岐: 最新枝 (b2) の配下でさらに rewind して 2 段目の分岐が生じる。
  const nestedLog = () =>
    jsonl(
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: TS,
        message: { role: "user", content: "?" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text: "どうぞ" }] },
      },
      {
        type: "user",
        uuid: "b1",
        parentUuid: "a1",
        timestamp: TS,
        message: { role: "user", content: "外側の旧枝" },
      },
      {
        type: "user",
        uuid: "b2",
        parentUuid: "a1",
        timestamp: TS,
        message: { role: "user", content: "外側の新枝" },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: "b2",
        timestamp: TS,
        message: { role: "assistant", content: [{ type: "text", text: "了解" }] },
      },
      {
        type: "user",
        uuid: "c1",
        parentUuid: "a2",
        timestamp: TS,
        message: { role: "user", content: "内側の旧枝" },
      },
      {
        type: "user",
        uuid: "c2",
        parentUuid: "a2",
        timestamp: TS,
        message: { role: "user", content: "内側の新枝" },
      },
    );

  test("rewind: ネスト分岐はデフォルトで両段とも最新枝を辿り branch を 2 つ出す", () => {
    const log = parseSessionLog(nestedLog());
    const branches = log.events.filter((e) => e.kind === "branch");
    expect(branches).toEqual([
      {
        kind: "branch",
        ts: TS,
        branchKey: "a1",
        selectedChildUuid: "b2",
        options: [
          { childUuid: "b1", index: 1, lead: "外側の旧枝", ts: TS },
          { childUuid: "b2", index: 2, lead: "外側の新枝", ts: TS },
        ],
      },
      {
        kind: "branch",
        ts: TS,
        branchKey: "a2",
        selectedChildUuid: "c2",
        options: [
          { childUuid: "c1", index: 1, lead: "内側の旧枝", ts: TS },
          { childUuid: "c2", index: 2, lead: "内側の新枝", ts: TS },
        ],
      },
    ]);
    const userTexts = log.events.filter((e) => e.kind === "user").map((e) => e.text);
    expect(userTexts).toEqual(["?", "外側の新枝", "内側の新枝"]);
  });

  test("rewind: 外側で旧枝を選ぶと内側の分岐は経路から外れ消える (分岐はノード単位で独立)", () => {
    const log = parseSessionLog(nestedLog(), new Map([["a1", "b1"]]));
    const branches = log.events.filter((e) => e.kind === "branch");
    // 外側 a1 のみ。b1 配下に分岐は無いので内側 branch は出ない。
    expect(branches.map((b) => (b.kind === "branch" ? b.branchKey : ""))).toEqual(["a1"]);
    const userTexts = log.events.filter((e) => e.kind === "user").map((e) => e.text);
    expect(userTexts).toEqual(["?", "外側の旧枝"]);
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
    expect(log.events).toEqual([
      { kind: "image", ts: TS, source: { mediaType: "image/png", base64: "AAAA" } },
    ]);
  });

  test("ホワイトリスト外 media_type の base64 image は source=undefined", () => {
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
    expect(log.events).toEqual([{ kind: "image", ts: TS, source: undefined }]);
  });

  test("base64 でない image block は source=undefined", () => {
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
    expect(log.events).toEqual([{ kind: "image", ts: TS, source: undefined }]);
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

describe("parseSessionLog model 収集", () => {
  function assistant(model: unknown): Record<string, unknown> {
    return {
      type: "assistant",
      timestamp: TS,
      message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] },
    };
  }

  test("assistant の message.model を採る", () => {
    const log = parseSessionLog(jsonl(assistant("claude-opus-4-8")));
    expect(log.models).toEqual(["claude-opus-4-8"]);
  });

  test("複数 model は出現順ユニーク (/model 切り替え)", () => {
    const log = parseSessionLog(
      jsonl(
        assistant("claude-opus-4-8"),
        assistant("claude-haiku-4-5-20251001"),
        assistant("claude-opus-4-8"),
      ),
    );
    expect(log.models).toEqual(["claude-opus-4-8", "claude-haiku-4-5-20251001"]);
  });

  test("null / 空 / <synthetic> は実モデルでないため除外", () => {
    const log = parseSessionLog(
      jsonl(assistant(null), assistant(""), assistant("<synthetic>"), assistant("claude-opus-4-8")),
    );
    expect(log.models).toEqual(["claude-opus-4-8"]);
  });

  test("assistant が無ければ空配列", () => {
    const log = parseSessionLog(
      jsonl({ type: "user", timestamp: TS, message: { role: "user", content: "hi" } }),
    );
    expect(log.models).toEqual([]);
  });
});
