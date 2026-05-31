import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { formatSessionTime, parseSessionLog } from "./sessionLog";

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

  test("slash command 注入 string は載せず skipped に計上", () => {
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
    expect(log.events).toEqual([]);
    expect(log.skipped).toBe(1);
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
