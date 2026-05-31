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
//
// 平文の無い thinking (最新モデルの暗号化 signature のみ / フィールド欠落) も載せないが、
// これは非会話レコードではなく会話イベントの一種なので skipped と混ぜず emptyThinking に
// 別集計する。footer は両者を別ラベルで示し、件数の意味を 1:1 に保つ。

import { tryCatch } from "@gozd/shared";

/** content ブロック (Anthropic Messages API スキーマ) */
interface TextBlock {
  type: "text";
  text: string;
}
interface ThinkingBlock {
  type: "thinking";
  // 信頼境界外の入力。最新モデルは平文を残さず空文字を書き、フィールド自体が欠落する
  // ケースも型では排除できないため optional 扱いにする。
  thinking?: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  // 信頼境界外の入力。空文字・フィールド欠落は型で排除できないため optional 扱いにする。
  name?: string;
  // 欠落すると下流の SessionLogToolArg が input[key] で実行時エラーになるため optional 扱い。
  input?: Record<string, unknown>;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}
interface ImageBlock {
  type: "image";
  // Anthropic Messages API の image source。base64 のみ data URL 化できる。
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
  };
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

// ログファイルは外部プロセス (Claude Code) が書く信頼境界外の入力。media_type を
// 既知の画像 MIME ホワイトリストで検証し、外れたら undefined (placeholder) に倒す。
// 未知 / 破損 MIME を無検証で data URL に通さず、挙動を決定的にする。
const ALLOWED_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** image block を表示用 data URL にする。既知 MIME の base64 source 以外は undefined。 */
function imageSrc(block: ImageBlock): string | undefined {
  const source = block.source;
  if (source === undefined) return undefined;
  if (
    source.type === "base64" &&
    source.media_type !== undefined &&
    source.data !== undefined &&
    ALLOWED_IMAGE_MEDIA_TYPES.has(source.media_type)
  ) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return undefined;
}

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

// harness / CLI が user role で注入するラッパーで始まる string。これらはユーザーの
// 生発話ではない (slash command 起動 / ローカルコマンド出力 / バックグラウンドタスク
// 完了通知 / システムリマインダ) ため USER ブロック / 目次に出さない。
//
// `type:"user"` + content=string + isMeta:null の形で main loop に注入されるため、
// isMeta フラグでは区別できず、先頭ラッパータグで判定する。実ユーザー発話はこれらの
// タグで始まらない (リマインダ等は発話の後ろに付くため先頭一致しない)。
const INJECTED_USER_WRAPPER_RE =
  /^\s*<(command-message|command-name|command-args|local-command-stdout|local-command-stderr|task-notification|system-reminder)>/;
function isInjectedUserText(text: string): boolean {
  return INJECTED_USER_WRAPPER_RE.test(text);
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
  | { kind: "image"; ts: string; src: string | undefined };

export interface ParsedSessionLog {
  events: TranscriptEvent[];
  /** 読んだ JSONL 行数 */
  totalLines: number;
  /** JSON parse に失敗した行数 (末尾の追記途中行など) */
  malformed: number;
  /** transcript に載せなかった非会話レコード数 (attachment / system 等) */
  skipped: number;
  /**
   * 平文が無く載せなかった thinking ブロック数。会話イベントだが表示できる中身が無い
   * (最新モデルは暗号化 signature だけを書き thinking は空 / 欠落)。非会話レコードの
   * skipped とは性質が異なるため別カウンタにし、footer で別ラベル表示する。
   */
  emptyThinking: number;
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
  let emptyThinking = 0;

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
        // slash command / task-notification 等の注入 string は生発話ではないので除外する。
        if (isInjectedUserText(content)) {
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
            events.push({ kind: "image", ts, src: imageSrc(block) });
          } else {
            // 未知 block type は無言で落とさず skipped に計上する (footer 観察可能性)。
            skipped++;
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
          // 最新モデル (opus-4-8 / sonnet-4-6 等) は思考の平文を transcript に残さず
          // 暗号化 signature だけを書く。この場合 thinking は空文字 / フィールド欠落になる。
          // 判定は signature の有無ではなく「表示できる平文があるか」で行う。平文が無ければ
          // 空ブロックとして並べず emptyThinking に計上する (件数は footer で観察可能)。
          if (block.thinking === undefined || block.thinking === "") {
            emptyThinking++;
          } else {
            events.push({ kind: "thinking", text: block.thinking, ts });
          }
        } else if (block.type === "tool_use") {
          const tool: Extract<TranscriptEvent, { kind: "tool" }> = {
            kind: "tool",
            // 見出しの中黒区切りを廃したため、空名だと TOOL ラベルだけになり種別が消える。
            // 信頼境界外ログの空名 / 欠落は可視マーカーに倒して種別を必ず描画する。
            name: block.name === undefined || block.name === "" ? "(unnamed tool)" : block.name,
            // input 欠落は下流の添字アクセス (input[key]) を実行時エラーにするため空 object に倒す。
            input: block.input ?? {},
            toolUseId: block.id,
            ts,
            result: undefined,
          };
          toolById.set(block.id, tool);
          events.push(tool);
        } else if (block.type === "image") {
          events.push({ kind: "image", ts, src: imageSrc(block) });
        } else {
          // 未知 block type は無言で落とさず skipped に計上する (footer 観察可能性)。
          skipped++;
        }
      }
      continue;
    }

    // user / assistant 以外 (attachment / system / progress / permission-mode 等) は
    // 会話 transcript には載せない。
    skipped++;
  }

  return { events, totalLines, malformed, skipped, emptyThinking };
}
