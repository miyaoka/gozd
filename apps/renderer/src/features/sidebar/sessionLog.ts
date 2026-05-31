// Claude Code セッションログ (JSONL) の parse と transcript モデル化。
//
// native の /claudeSession/readLog が返す生 JSONL を行ごとに parse し、
// user / assistant(text / thinking / tool_use) / tool_result を時系列の
// イベントブロック列に変換する。tool_use と tool_result は tool_use_id で
// ペア化し、1 つの tool イベントにまとめる。
//
// 表示対象は会話イベント (user / assistant / thinking / tool / image) に限定する。
// attachment / progress / system / permission-mode 等の非会話レコードは transcript には
// 載せず、件数だけ ParsedSessionLog.skipped に集計して観察可能性を残す
// (silent drop 禁止規律: 落とした事実を呼び出し元が UI で示せるようにする)。

import { tryCatch } from "@gozd/shared";

/** content ブロック (Anthropic Messages API スキーマ) */
interface TextBlock {
  type: "text";
  text: string;
}
interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}
interface ImageBlock {
  type: "image";
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

interface RawMessage {
  role?: string;
  content?: string | ContentBlock[];
}
interface RawLine {
  type?: string;
  timestamp?: string;
  message?: RawMessage;
  // CLI / hook が注入したシステム由来レコード。ユーザー発話ではないので transcript に載せない。
  isMeta?: boolean;
}

// CLI が user レコードに注入するラッパー (slash command 起動 / ローカルコマンド出力)。
// これらはユーザーの生発話ではないため USER ブロック / 目次に出さない。
const COMMAND_INJECTION_RE =
  /^\s*<(command-message|command-name|command-args|local-command-stdout|local-command-stderr)>/;
function isCommandInjectionText(text: string): boolean {
  return COMMAND_INJECTION_RE.test(text);
}

/** transcript の 1 ブロック。discriminated union (kind で分岐) */
export type TranscriptEvent =
  | { kind: "user"; text: string; ts: string }
  | { kind: "assistant"; text: string; ts: string }
  | { kind: "thinking"; text: string; ts: string }
  | {
      kind: "tool";
      name: string;
      input: Record<string, unknown>;
      toolUseId: string;
      ts: string;
      result: { text: string; isError: boolean } | undefined;
    }
  | { kind: "image"; ts: string };

export interface ParsedSessionLog {
  events: TranscriptEvent[];
  /** 読んだ JSONL 行数 */
  totalLines: number;
  /** JSON parse に失敗した行数 (末尾の追記途中行など) */
  malformed: number;
  /** transcript に載せなかった非会話レコード数 (attachment / system 等) */
  skipped: number;
}

/**
 * tool_result content (string | block[]) を表示用テキストに正規化する。
 *
 * text / image 以外の block 種別は空文字で握り潰さず `[unsupported: <type>]` の
 * 可視マーカーにする (silent drop 回避。未知スキーマが来ても観察可能にする)。
 */
function toolResultText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return "[image]";
      return `[unsupported: ${block.type}]`;
    })
    .filter((s) => s !== "")
    .join("\n");
}

/**
 * 生 JSONL を transcript に変換する。
 *
 * tool_use は出現位置 (assistant ブロック直後) に tool イベントを置き、後続の user 行に
 * 現れる tool_result を tool_use_id で引き当てて同じイベントに result を充填する。これで
 * 「コマンド + 実行結果」が 1 ブロックに畳まれ、時系列上の位置も保たれる。
 */
export function parseSessionLog(jsonl: string): ParsedSessionLog {
  const events: TranscriptEvent[] = [];
  // tool_use_id → 生成済み tool イベント。後続の tool_result を充填する。
  const toolById = new Map<string, Extract<TranscriptEvent, { kind: "tool" }>>();

  let totalLines = 0;
  let malformed = 0;
  let skipped = 0;

  const lines = jsonl.split("\n");
  for (const line of lines) {
    if (line.trim() === "") continue;
    totalLines++;

    const parsed = tryCatch(() => JSON.parse(line) as RawLine);
    if (!parsed.ok) {
      malformed++;
      continue;
    }
    const raw = parsed.value;
    const ts = raw.timestamp ?? "";

    // CLI / hook 注入のシステムレコードはユーザー発話ではないので会話に載せない。
    if (raw.isMeta === true) {
      skipped++;
      continue;
    }

    if (raw.type === "user") {
      const content = raw.message?.content;
      if (typeof content === "string") {
        // slash command 起動ラッパー等の注入 string は生発話ではないので除外する。
        if (isCommandInjectionText(content)) {
          skipped++;
          continue;
        }
        events.push({ kind: "user", text: content, ts });
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            events.push({ kind: "user", text: block.text, ts });
          } else if (block.type === "tool_result") {
            const tool = toolById.get(block.tool_use_id);
            // 親 tool_use を読む前に tool_result が来ることは通常ないが、fork コピーや
            // 途中欠落で引き当てに失敗したら捨てずに skipped に計上する。
            if (tool === undefined) {
              skipped++;
              continue;
            }
            tool.result = {
              text: toolResultText(block.content),
              isError: block.is_error === true,
            };
          } else if (block.type === "image") {
            events.push({ kind: "image", ts });
          }
        }
        continue;
      }
      skipped++;
      continue;
    }

    if (raw.type === "assistant") {
      const content = raw.message?.content;
      if (!Array.isArray(content)) {
        skipped++;
        continue;
      }
      for (const block of content) {
        if (block.type === "text") {
          events.push({ kind: "assistant", text: block.text, ts });
        } else if (block.type === "thinking") {
          events.push({ kind: "thinking", text: block.thinking, ts });
        } else if (block.type === "tool_use") {
          const tool: Extract<TranscriptEvent, { kind: "tool" }> = {
            kind: "tool",
            name: block.name,
            input: block.input,
            toolUseId: block.id,
            ts,
            result: undefined,
          };
          toolById.set(block.id, tool);
          events.push(tool);
        }
      }
      continue;
    }

    // user / assistant 以外 (attachment / system / progress / permission-mode 等) は
    // 会話 transcript には載せない。
    skipped++;
  }

  return { events, totalLines, malformed, skipped };
}
