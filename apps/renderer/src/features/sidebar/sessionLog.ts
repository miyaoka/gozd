// Claude Code セッションログ (JSONL) の parse と transcript モデル化。
//
// native の /claudeSession/readLog が返す生 JSONL を行ごとに parse し、
// user / assistant(text / thinking / tool_use) / tool_result を時系列の
// イベントブロック列に変換する。tool_use と tool_result は tool_use_id で
// ペア化し、1 つの tool イベントにまとめる。
//
// 表示対象は会話イベント (user / assistant / thinking / tool / image) に限定する。
// progress / system / permission-mode 等の非会話レコードは transcript には載せず、件数だけ
// ParsedSessionLog.skipped に集計して観察可能性を残す (silent drop 禁止規律: 落とした事実を
// 呼び出し元が UI で示せるようにする)。
//
// attachment は原則 skipped だが、`queued_command` (エージェント作業中にユーザーが打ち
// queue に積んだ発話) だけは例外で、本文が `type:"user"` に昇格せず attachment.prompt にしか
// 残らないことがあるため USER ブロックに載せる。採否は上流が分類済みの attachment.commandMode
// を SSOT にし、生発話 ("prompt") のみ拾う。注入通知 ("task-notification" 等) は除外する。
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
  // 信頼境界外の入力。欠落は型で排除できないため optional 扱いにする。tool_result との
  // ペアリングキー兼 subagent 紐付けキーなので、欠落時は空文字に倒さず未ペア扱いにする。
  id?: string;
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
// `type:"attachment"` レコードの中身。queued_command のみ会話に載せるため prompt を読む。
interface RawAttachment {
  type?: string;
  // queued_command が積んだ発話本文。信頼境界外の入力なので optional。
  prompt?: string;
  // queue 種別の SSOT。"prompt" = ユーザーの生発話 / "task-notification" = 注入通知。
  // 上流 (Claude Code) が分類済みのため本文パターンで再導出せずこのフィールドで採否を決める。
  commandMode?: string;
}
interface RawLine {
  type?: string;
  timestamp?: string;
  message?: RawMessage;
  attachment?: RawAttachment;
  // CLI / hook が注入したシステム由来レコード。ユーザー発話ではないので transcript に載せない。
  isMeta?: boolean;
}

// harness / CLI が user role で注入するラッパーで始まる string。これらはユーザーの
// 生発話ではない (ローカルコマンド出力 / バックグラウンドタスク完了通知 / システム
// リマインダ) ため USER ブロック / 目次に出さない。
//
// `type:"user"` + content=string + isMeta:null の形で main loop に注入されるため、
// isMeta フラグでは区別できず、先頭ラッパータグで判定する。実ユーザー発話はこれらの
// タグで始まらない (リマインダ等は発話の後ろに付くため先頭一致しない)。
const INJECTED_USER_WRAPPER_RE =
  /^\s*<(local-command-stdout|local-command-stderr|task-notification|system-reminder)>/;
function isInjectedUserText(text: string): boolean {
  return INJECTED_USER_WRAPPER_RE.test(text);
}

// slash command 起動は `type:"user"` の string content として記録され、先頭が
// `<command-name>/foo</command-name>` か `<command-message>foo</command-message>` で始まる。
// この先頭判定でだけ command block とみなす。本文中にたまたま <command-name> を含む生発話
// (このログ機能自体を議論する発話など) を slash command と誤認して切り詰めるのを防ぐため、
// 抽出側 (COMMAND_NAME_RE) ではなく先頭アンカーを持つこの RE で採否を決める。
const COMMAND_BLOCK_LEAD_RE = /^\s*<(command-name|command-message)>/;
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/** command block string から表示用テキスト (`/foo` または `/foo args`) を取り出す。command-name が無い病的ブロックは undefined。 */
function slashCommandText(text: string): string | undefined {
  const nameMatch = COMMAND_NAME_RE.exec(text);
  if (nameMatch === null) return undefined;
  const name = nameMatch[1].trim();
  if (name === "") return undefined;
  const argsMatch = COMMAND_ARGS_RE.exec(text);
  const args = argsMatch === null ? "" : argsMatch[1].trim();
  return args === "" ? name : `${name} ${args}`;
}

/**
 * `type:"user"` の string content を表示用テキストに正規化する。表示すべきでないものは
 * undefined を返す (呼び出し側で skipped)。
 *
 * - 先頭が command block → slash command 起動。コマンド名 (+ 引数) を出す。command-name を
 *   欠いた病的ブロックは undefined
 * - 先頭が注入ラッパー (ローカルコマンド出力 / task-notification / system-reminder) → 除外
 * - それ以外は生発話としてそのまま出す (本文中の <command-name> 等は加工しない)
 */
function userTextOf(text: string): string | undefined {
  if (COMMAND_BLOCK_LEAD_RE.test(text)) return slashCommandText(text);
  if (isInjectedUserText(text)) return undefined;
  return text;
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
        // slash command はコマンド名を出し、task-notification 等の注入 string は除外する。
        const text = userTextOf(content);
        if (text === undefined) {
          skipped++;
          continue;
        }
        events.push({ kind: "user", text, ts });
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
          // id 欠落は信頼境界外ログの病的ケース。空文字 sentinel に倒すと別の id 欠落
          // tool_use と Map キーが衝突し tool_result ペアリングを取り違うため、未ペア
          // (toolById に登録しない / subagent 紐付けキーも空) として扱う。
          const toolUseId = block.id ?? "";
          const tool: Extract<TranscriptEvent, { kind: "tool" }> = {
            kind: "tool",
            // 見出しの中黒区切りを廃したため、空名だと TOOL ラベルだけになり種別が消える。
            // 信頼境界外ログの空名 / 欠落は可視マーカーに倒して種別を必ず描画する。
            name: block.name === undefined || block.name === "" ? "(unnamed tool)" : block.name,
            // input 欠落は下流の添字アクセス (input[key]) を実行時エラーにするため空 object に倒す。
            input: block.input ?? {},
            toolUseId,
            ts,
            result: undefined,
          };
          // id がある時だけ result 充填用に登録する。空 id を登録すると衝突源になる。
          if (toolUseId !== "") toolById.set(toolUseId, tool);
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

    // queued_command (ユーザーが作業中に queue に積んだ発話) は type:"user" に昇格せず
    // attachment.prompt にしか本文が残らないことがあるため USER ブロックに載せる。採否は
    // 上流が分類済みの commandMode を SSOT にし、生発話 ("prompt") のみ拾う。注入通知
    // ("task-notification" 等) は除外する。prompt は生発話なので本文を加工せずそのまま出す
    // (本文が <span> や <command-name> 始まりの正当な発話を切り詰めない)。
    if (raw.type === "attachment" && raw.attachment?.type === "queued_command") {
      const { commandMode, prompt } = raw.attachment;
      if (commandMode === "prompt" && prompt !== undefined && prompt !== "") {
        events.push({ kind: "user", text: prompt, ts });
        continue;
      }
      skipped++;
      continue;
    }

    // 上記以外 (その他 attachment / system / progress / permission-mode 等) は
    // 会話 transcript には載せない。
    skipped++;
  }

  return { events, totalLines, malformed, skipped, emptyThinking };
}

// --- ログファイルのパス解決 (SessionLogDialog のライブ更新 watch が使う) ---

/**
 * entry 配列の main jsonl が置かれた親 dir を返す。`<projectDir>/<sessionId>.jsonl` →
 * `<projectDir>`。ライブ更新でこの親 dir を watch する。macOS 専用 (区切りは "/")。
 * 次の境界では undefined を返す (watch を張らない):
 *   - main が無く先頭 entry も path 空
 *   - "/" を含まない / ルート直下 (`foo.jsonl` や `/foo.jsonl`、slash <= 0)
 */
export function sessionLogDirOf(entries: { kind: string; path: string }[]): string | undefined {
  const mainPath = entries.find((e) => e.kind === "main")?.path ?? entries[0]?.path;
  if (mainPath === undefined || mainPath === "") return undefined;
  const slash = mainPath.lastIndexOf("/");
  if (slash <= 0) return undefined;
  return mainPath.slice(0, slash);
}

// --- subagent 紐付け / 時刻ジャンプ (SessionLogDialog / SessionLogTranscript が使う純関数) ---

/** main の Agent / SendMessage 行を起動/宛先 subagent に結ぶリンク。 */
export interface SubagentLink {
  agentId: string;
  label: string;
}

/** buildSubagentLinks が参照する subagent の最小情報 (SessionTab の射影)。 */
export interface SubagentDescriptor {
  id: string; // agent_id
  label: string; // 表示ラベル
  name: string; // meta.json の name (SendMessage の to が name のことがある)
  parentToolUseId: string; // spawn した main 側 Agent tool_use id
  // workflow agent が属する workflow run の id (wf_xxx)。非 workflow subagent は空文字。
  // main の Workflow tool_use を workflow agent 群に結ぶグループキー。
  workflowRunId: string;
  // workflow の表示名。Workflow 行のリンクラベルに使う。非 workflow subagent は空文字。
  workflowName: string;
}

// main の Workflow tool_result テキストに含まれる `Run ID: wf_xxx`。これが main の Workflow
// tool_use を workflow agent 群 (workflowRunId) に結ぶ唯一の正規キー。先頭アンカーは張らない
// (結果テキストの途中行に出るため)。wf_ id は `wf_` + 16進/ハイフン構成。
const WORKFLOW_RUN_ID_RE = /Run ID:\s*(wf_[A-Za-z0-9-]+)/;

/**
 * main の tool 呼び出し (Agent / SendMessage) を起動/宛先 subagent に結ぶ map を作る。
 * key は main tool event の toolUseId、value は紐づく subagent の {agentId,label}。
 *
 * - Agent (新規 spawn): main の `tool_use.id` === subagent の `parentToolUseId` (meta.toolUseId)
 * - SendMessage (resume): main の `tool_use.input.to` === subagent の `id` または `name`
 *   (Claude Code の SendMessage は to に agent_id / agent name のどちらも取りうるため両引き)。
 *   id を優先し name にフォールバックする。ただし同名 subagent が複数あると name では一意に
 *   決められないため、その name はリンクを張らない (誤った subagent へ飛ばすより無表示が安全)。
 *   id は一意なので衝突しない。
 * - Workflow (workflow 起動): main の Workflow tool_result テキストの `Run ID: wf_xxx` ===
 *   workflow agent 群の `workflowRunId`。1 Workflow = N agent なので先頭 agent に結ぶ
 *   (右ペインで開いた後はタブバーのグループから他 agent へ辿れる)。ラベルは `<名> (件数)`。
 *
 * toolUseId が空 (id 欠落 tool_use) の event は紐付け対象外。
 */
export function buildSubagentLinks(
  mainEvents: TranscriptEvent[],
  subagents: SubagentDescriptor[],
): Map<string, SubagentLink> {
  const links = new Map<string, SubagentLink>();
  const byParentToolUse = new Map<string, SubagentDescriptor>();
  const byAgentId = new Map<string, SubagentDescriptor>();
  const byName = new Map<string, SubagentDescriptor>();
  // workflowRunId → その workflow の agent 群 (出現順)。Workflow 行リンク用。
  const byWorkflowRunId = new Map<string, SubagentDescriptor[]>();
  // 複数 subagent が同じ name を持つ場合、その name では一意に引けないので除外対象にする。
  const ambiguousNames = new Set<string>();
  for (const sub of subagents) {
    if (sub.parentToolUseId !== "") byParentToolUse.set(sub.parentToolUseId, sub);
    byAgentId.set(sub.id, sub);
    if (sub.name !== "") {
      if (byName.has(sub.name)) ambiguousNames.add(sub.name);
      else byName.set(sub.name, sub);
    }
    if (sub.workflowRunId !== "") {
      const group = byWorkflowRunId.get(sub.workflowRunId);
      if (group === undefined) byWorkflowRunId.set(sub.workflowRunId, [sub]);
      else group.push(sub);
    }
  }

  // id 引きを優先し、引けない時だけ name にフォールバック。曖昧な name は引かない。
  const resolveTo = (to: string): SubagentDescriptor | undefined => {
    const byId = byAgentId.get(to);
    if (byId !== undefined) return byId;
    if (ambiguousNames.has(to)) return undefined;
    return byName.get(to);
  };

  // Workflow 行: result テキストの `Run ID: wf_xxx` で agent 群を引き、先頭 agent に結ぶ。
  // 結果未記録 / runId 抽出失敗 / 該当 agent ゼロ件はリンクを張らない (無表示が安全)。
  const resolveWorkflow = (resultText: string | undefined): SubagentLink | undefined => {
    if (resultText === undefined) return undefined;
    const match = WORKFLOW_RUN_ID_RE.exec(resultText);
    if (match === null) return undefined;
    const group = byWorkflowRunId.get(match[1]);
    const [first] = group ?? [];
    if (first === undefined) return undefined;
    const name = first.workflowName !== "" ? first.workflowName : match[1];
    const groupCount = group?.length ?? 0;
    return { agentId: first.id, label: `${name} (${groupCount})` };
  };

  for (const ev of mainEvents) {
    if (ev.kind !== "tool" || ev.toolUseId === "") continue;
    if (ev.name === "Agent") {
      const sub = byParentToolUse.get(ev.toolUseId);
      if (sub !== undefined) links.set(ev.toolUseId, { agentId: sub.id, label: sub.label });
    } else if (ev.name === "SendMessage") {
      const to = ev.input.to;
      if (typeof to === "string") {
        const sub = resolveTo(to);
        if (sub !== undefined) links.set(ev.toolUseId, { agentId: sub.id, label: sub.label });
      }
    } else if (ev.name === "Workflow") {
      const link = resolveWorkflow(ev.result?.text);
      if (link !== undefined) links.set(ev.toolUseId, link);
    }
  }
  return links;
}

/**
 * events の中で `ts` に最も近いイベントの index を返す。空文字 / parse 不能な ts のイベントは
 * スキップする。対象が無い (空 events / 全 ts 不正 / `ts` 自体が不正) なら undefined。
 * 同値 diff のタイは最小 index (最も早い) を選ぶ。
 */
export function nearestEventIndexByTs(events: TranscriptEvent[], ts: string): number | undefined {
  const target = Date.parse(ts);
  if (Number.isNaN(target)) return undefined;
  let best: number | undefined;
  let bestDiff = Infinity;
  events.forEach((ev, index) => {
    const t = Date.parse(ev.ts);
    if (Number.isNaN(t)) return;
    const diff = Math.abs(t - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = index;
    }
  });
  return best;
}

/** 表示用に分解した timestamp。日付は今日なら空文字 (時刻のみで足りる)。 */
export interface FormattedSessionTime {
  date: string;
  time: string;
}

// 時刻 / 日付の Intl formatter (SSOT)。生成コストの高い formatter をモジュールレベルで
// 一度だけ作り、イベントごとの整形で使い回す。いずれも 24h 固定 (引数なしの toLocale* は
// 環境次第で AM/PM になり tabular-nums 整列が崩れる)。
// - 時刻: 秒ありは目次 (時刻の一意性に依存)、秒なしは吹き出し脇 (会話の時刻は分まで)
// - 日付: 同年は M/D、別年は YYYY/M/D
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const TIME_FORMATTER_NO_SECONDS = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const DATE_FORMATTER_SAME_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
});
const DATE_FORMATTER_OTHER_YEAR = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/**
 * ISO timestamp を表示用に日付 / 時刻へ分解する (SSOT)。空 / 不正なら両方空文字。
 *
 * 秒は `seconds` で出し分ける: 目次は時刻の一意性に依存するため秒まで出すが、吹き出し脇は
 * 会話の時刻表示なので分までで足りる。日付は今日なら空文字、今年は M/D、別年は YYYY/M/D を
 * 返し、resume で日 / 年をまたいだセッションのエントリを一意に区別できるようにする。
 * 目次は日付 + 時刻を 1 行に連結し、吹き出し脇は 2 行に分けて使う。
 */
export function formatSessionTime(
  ts: string,
  { seconds = true }: { seconds?: boolean } = {},
): FormattedSessionTime {
  if (ts === "") return { date: "", time: "" };
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return { date: "", time: "" };

  const now = new Date();
  const time = (seconds ? TIME_FORMATTER : TIME_FORMATTER_NO_SECONDS).format(date);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return { date: "", time };

  const sameYear = date.getFullYear() === now.getFullYear();
  const dateStr = (sameYear ? DATE_FORMATTER_SAME_YEAR : DATE_FORMATTER_OTHER_YEAR).format(date);
  return { date: dateStr, time };
}
