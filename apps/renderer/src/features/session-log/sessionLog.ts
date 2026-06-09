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
//
// rewind 対応: Claude Code の JSONL は append-only で、rewind しても旧レコードを消さず過去の
// uuid を parentUuid に指して新レコードを追記する。このため uuid/parentUuid は木 (DAG) を成し、
// 行を逐次読むと捨てられた枝も混ざる。parseSessionLog は全レコードをファイル順に出しつつ、
// 捨てられた rewind 枝だけを刈る。分岐点 (同一親に分岐候補が 2 つ以上) で選択中 (未指定なら最新)
// 以外の候補のサブツリーを除外し、選択枝の先頭に branch イベントを挿して UI でセレクタを出す。
// rewind は会話木の任意のノードで独立に起きるため、分岐は session 単位ではなくノード単位で扱う。
//
// 分岐候補は「実発話 user / text・thinking を持つ assistant」に限定する。並列 tool 呼び出しは
// 1 つの tool_use が「次の tool_use」と「自身の tool_result」の 2 子を持つ DAG を作るが、これは
// rewind ではない。子 2 つを機械的に分岐とみなすと本流を捨て枝として落とすため、tool_use /
// tool_result を候補から外して誤検出を防ぐ (詳細は isBranchCandidate)。

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
  // assistant レコードが実際に使った model 名 (例 "claude-opus-4-8")。信頼境界外の入力で
  // null / 空 / システム生成の "<synthetic>" がありうるため optional かつ null 許容にする。
  model?: string | null;
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
  // レコードの一意 id と親 id。Claude Code は append-only に書き、rewind 時は過去の uuid を
  // parentUuid に指して新レコードを追記する (旧枝は消さない)。このため uuid/parentUuid の木に
  // 分岐が生じ、「現在の会話」は tip から遡る 1 本道になる。rewind 検出の唯一の情報源。
  // 古いログ / 注入レコードは uuid を持たない (型で排除できないため optional)。parentUuid は
  // ルートで null になりうる。
  uuid?: string;
  parentUuid?: string | null;
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

/**
 * Claude Code SDK が会話ターン整合のために合成する assistant メッセージか。`model:"<synthetic>"`
 * が discriminator。例: assistant の実応答後に SDK が `[{type:"text", text:"No response requested."}]`
 * + `model:"<synthetic>"` の assistant レコードを同じ親に追記する。これは実応答ではないため
 * transcript / rewind 兄弟検出のどちらにも乗せない。
 *
 * 既存の `isMeta:true` user filter (`raw.isMeta === true` → `isBranchCandidate` で false 返却 +
 * 後段の render loop で skipped) と対称な役割を担う。両 filter とも (a) `isBranchCandidate` で
 * branch 候補から外し、(b) render loop 先頭で transcript への push を skipped に倒す、の 2 役割を
 * 兼ねる。`isMeta` (既存) は CLI/hook 注入の user レコードを、`isSyntheticAssistant` (本ヘルパー)
 * は SDK 合成 assistant レコードをそれぞれ受け持つ。
 */
function isSyntheticAssistant(raw: RawLine): boolean {
  return raw.type === "assistant" && raw.message?.model === "<synthetic>";
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

/** rewind 分岐の 1 選択肢。`index` は古い順 1 始まり (最新が最大番号)。 */
interface BranchOption {
  // この枝の先頭会話ノードの uuid。selection マップのキー兼選択値。
  childUuid: string;
  // 表示番号。出現順 (= 古い順) に 1, 2, 3 …。最新枝が最大番号。
  index: number;
  // 枝を識別するための先頭テキスト (この枝の最初のプロンプト / 応答の冒頭)。
  lead: string;
  // この枝の先頭会話ノードの timestamp。
  ts: string;
}

/** AskUserQuestion の 1 件の質問 (選択肢 + 充填済み回答)。 */
interface AskOption {
  label: string;
  description: string;
}
interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
  /** tool_result から parse した回答。resume 中断 / 未充填は undefined。 */
  answer: string | undefined;
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
  // AskUserQuestion 専用イベント。assistant の質問 (+選択肢) と user の回答を 1 つの構造に
  // 畳む。実体は tool_use + tool_result だが、UI 上は会話 (Q→A) として扱いたいため通常の
  // tool イベントとは区別する。1 つの AskUserQuestion は複数 question を取れるので
  // questions[] に並べ、それぞれに answer を紐づける。resume 等で result が来ないケースは
  // 各 answer が undefined のまま残る。
  | {
      kind: "ask";
      ts: string;
      toolUseId: string;
      questions: AskQuestion[];
    }
  | { kind: "image"; ts: string; src: string | undefined }
  // rewind 分岐点。選択中の枝の先頭会話ノードの直前に挿入する。UI はここにセレクタを出し、
  // 別の枝を選ぶと selection が更新され transcript が再構築される。
  | {
      kind: "branch";
      ts: string;
      // 分岐点の会話ノード uuid (この枝群の共通の親)。selection マップのキー。
      branchKey: string;
      // 現在描画中の枝の childUuid。
      selectedChildUuid: string;
      options: BranchOption[];
    };

export interface ParsedSessionLog {
  events: TranscriptEvent[];
  /**
   * この agent (main または subagent 1 つ) が実際に使った model 名を出現順ユニークで持つ。
   * assistant レコードの message.model が SSOT。null / 空 / "<synthetic>" は除く。通常 1 件だが
   * セッション中の /model 切り替えで複数になりうるため配列で保持する。effort は JSONL に書き
   * 出されず agent 定義 frontmatter 側にしか無いため、セッションファイル自己完結の方針として
   * model のみ採る。
   */
  models: string[];
  /** 表示した (live な) JSONL 行数。rewind で選ばれなかった枝の行は含まない */
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

// --- AskUserQuestion 専用 helper ---

/**
 * AskUserQuestion tool 名。SSOT。判定はこのリテラル一致のみ (大小文字違いや別名は持たない)。
 */
const ASK_TOOL_NAME = "AskUserQuestion";

/**
 * AskUserQuestion の tool_result.content テキストから "Q"="A" ペアを引き抜く。
 *
 * 実ログの形:
 *   `Your questions have been answered: "Q1"="A1", "Q2"="A2". You can now continue …`
 *
 * 信頼境界外の出力なので形が崩れた場合 (regex 不一致) は空 Map に倒し、UI 側で
 * `answer === undefined` のまま描画させる (silent drop ではなく可視化)。
 */
const ASK_RESULT_PAIR_RE = /"([^"]+)"="([^"]*)"/g;
function parseAskAnswers(resultText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of resultText.matchAll(ASK_RESULT_PAIR_RE)) {
    map.set(m[1], m[2]);
  }
  return map;
}

/**
 * tool_use.input から AskUserQuestion 用の questions[] を取り出す。信頼境界外なので
 * 各フィールド欠落 / 型違いを許容して空文字 / 空配列 / false に倒す。
 */
function normalizeAskQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  return raw.map((q): AskQuestion => {
    const obj = (typeof q === "object" && q !== null ? q : {}) as Record<string, unknown>;
    const rawOptions = obj.options;
    const options: AskOption[] = Array.isArray(rawOptions)
      ? rawOptions.map((opt) => {
          const o = (typeof opt === "object" && opt !== null ? opt : {}) as Record<string, unknown>;
          return {
            label: typeof o.label === "string" ? o.label : "",
            description: typeof o.description === "string" ? o.description : "",
          };
        })
      : [];
    return {
      question: typeof obj.question === "string" ? obj.question : "",
      header: typeof obj.header === "string" ? obj.header : "",
      multiSelect: obj.multiSelect === true,
      options,
      answer: undefined,
    };
  });
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

/** branchKey (分岐点 = 候補が共有する親 uuid) → 選択した childUuid。未指定の分岐点は最新枝を採る。 */
export type BranchSelection = Map<string, string>;

/** parse 済みの 1 行 (rewind 木の構築に使う最小情報)。 */
interface LogNode {
  raw: RawLine;
  uuid: string; // raw.uuid ?? "" (uuid 無し = 木に参加しない古いログ / 注入レコード)
  parentUuid: string; // raw.parentUuid ?? ""
}

// 分岐選択肢の lead テキストの最大長。これを超えたら省略記号で切る。
const LEAD_MAX = 80;

/**
 * rewind 分岐の候補ノードか。「同一親に 2 つ以上並ぶと rewind 分岐」とみなせるのは、実発話 user
 * (text / image を持つ。tool_result / 注入 / meta を除く) と、text / thinking を持つ assistant
 * (応答の起点。tool_use のみのレコードを除く) だけ。
 *
 * これを限定しないと並列 tool 呼び出しの DAG を分岐と誤検出する。Claude Code は 1 ターンで複数
 * tool を呼ぶと、ある tool_use レコードが「次の tool_use」と「自身の tool_result」の 2 子を持つ
 * 構造を書く。これは rewind ではないが、子 2 つを機械的に分岐とみなすと本流を捨て枝として落とし、
 * デフォルト表示から tool 呼び出しが大量に消える。tool_use / tool_result はこの定義で候補から
 * 外れるため、tool の連鎖は分岐にならない。真の rewind は実発話 / 応答が同一親に複数並ぶ場合のみ。
 */
function isBranchCandidate(raw: RawLine): boolean {
  if (isSyntheticAssistant(raw)) return false;
  const content = raw.message?.content;
  if (raw.type === "user") {
    if (raw.isMeta === true) return false;
    if (typeof content === "string") return userTextOf(content) !== undefined;
    if (Array.isArray(content)) return content.some((b) => b.type === "text" || b.type === "image");
    return false;
  }
  if (raw.type === "assistant" && Array.isArray(content)) {
    return content.some(
      (b) =>
        (b.type === "text" && b.text !== "") ||
        (b.type === "thinking" && b.thinking !== undefined && b.thinking !== ""),
    );
  }
  return false;
}

/** 分岐候補ノードの先頭テキスト (選択肢の識別ラベル)。空なら "" 。LEAD_MAX で切る。 */
function nodeLeadText(raw: RawLine): string {
  const content = raw.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = (raw.type === "user" ? userTextOf(content) : content) ?? "";
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text") {
        text = block.text;
        break;
      }
    }
  }
  text = text.trim();
  return text.length > LEAD_MAX ? `${text.slice(0, LEAD_MAX)}…` : text;
}

/**
 * 生 JSONL を transcript に変換する。
 *
 * tool_use は出現位置 (assistant ブロック直後) に tool イベントを置き、後続の user 行に
 * 現れる tool_result を tool_use_id で引き当てて同じイベントに result を充填する。これで
 * 「コマンド + 実行結果」が 1 ブロックに畳まれ、時系列上の位置も保たれる。
 *
 * rewind 対応: 全レコードをファイル順に表示しつつ、捨てられた rewind 枝だけを刈る。分岐点
 * (同一親に分岐候補が 2 つ以上) で選択中 (未指定なら最新) 以外の候補のサブツリーを除外する。
 * `selection` で分岐点ごとに別の枝を選べる。並列 tool の DAG は分岐候補にならないため落とさない。
 * uuid を持たないレコード (古いログ / 注入) は木に参加せず常に表示するため、rewind が無いログの
 * 挙動は不変。
 */
export function parseSessionLog(jsonl: string, selection?: BranchSelection): ParsedSessionLog {
  const events: TranscriptEvent[] = [];
  // tool_use_id → 生成済み tool イベント。後続の tool_result を充填する。
  const toolById = new Map<string, Extract<TranscriptEvent, { kind: "tool" }>>();
  // tool_use_id → 生成済み ask イベント。後続の tool_result を answer 充填に使う。
  // toolById と key 空間を分けると AskUserQuestion / それ以外で経路が混ざらず、tool_result の
  // 引き当てが「どちらの table にいるか」で一意に決まる。
  const askById = new Map<string, Extract<TranscriptEvent, { kind: "ask" }>>();

  let totalLines = 0;
  let malformed = 0;
  let skipped = 0;
  let emptyThinking = 0;
  // 実 model 名を出現順ユニークで集める。seen は重複判定、models は順序保持。
  const models: string[] = [];
  const seenModels = new Set<string>();

  // --- フェーズ 1: 全行を parse して LogNode に正規化する (rewind 木の素材) ---
  const nodes: LogNode[] = [];
  for (const line of jsonl.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = tryCatch(() => JSON.parse(line) as RawLine);
    if (!parsed.ok) {
      malformed++;
      continue;
    }
    const raw = parsed.value;
    nodes.push({
      raw,
      uuid: raw.uuid ?? "",
      parentUuid: typeof raw.parentUuid === "string" ? raw.parentUuid : "",
    });
  }

  // --- フェーズ 2: rewind 木を構築し、捨て枝 (非選択候補のサブツリー) を刈る ---
  // uuid → LogNode と parentUuid → 子 LogNode[] (出現順)。前者は会話的親の遡上、後者は
  // サブツリー prune に使う。uuid を持つレコードのみ木に参加する。
  const byUuid = new Map<string, LogNode>();
  const childrenByParent = new Map<string, LogNode[]>();
  for (const node of nodes) {
    if (node.uuid === "") continue;
    byUuid.set(node.uuid, node);
    const arr = childrenByParent.get(node.parentUuid);
    if (arr === undefined) childrenByParent.set(node.parentUuid, [node]);
    else arr.push(node);
  }

  // 分岐候補ノードの「会話的親」= parentUuid を遡り最初に出会う分岐候補ノードの uuid。無ければ ""。
  // attachment / system / tool_use / tool_result 等の非候補ノードを透過する。rewind 候補は同一の
  // 直接親を共有するとは限らない (枝ごとに異なる透過ノードが分岐点と prompt の間に挟まりうる。実ログ
  // で確認済み: 一方の prompt の親が attachment、他方が system で、共通祖先が会話的親の assistant)。
  // 会話的親で揃えて初めて同一分岐点として検出できる。
  const convAncestor = (node: LogNode): string => {
    let cur = node.parentUuid;
    const guard = new Set<string>(); // 循環参照ガード (信頼境界外データ)
    while (cur !== "" && !guard.has(cur)) {
      guard.add(cur);
      const p = byUuid.get(cur);
      if (p === undefined) return ""; // 親不在 (fork コピー / 欠落) は ROOT 扱いで遡上打ち切り
      if (isBranchCandidate(p.raw)) return cur;
      cur = p.parentUuid;
    }
    return "";
  };

  // 会話的親 uuid ("" = ROOT) → 分岐候補の子 LogNode[] (出現順)。同一会話的親に候補が 2 つ以上
  // 並ぶ箇所が rewind 分岐。tool_use / tool_result は候補でないため並列 tool の DAG は分岐にならない。
  const convChildren = new Map<string, LogNode[]>();
  for (const node of nodes) {
    if (node.uuid === "" || !isBranchCandidate(node.raw)) continue;
    const key = convAncestor(node);
    const arr = convChildren.get(key);
    if (arr === undefined) convChildren.set(key, [node]);
    else arr.push(node);
  }

  // 選択枝先頭の childUuid → 直前に挿す branch イベント。
  const branchAtChild = new Map<string, Extract<TranscriptEvent, { kind: "branch" }>>();
  // 捨て枝 (非選択候補) のサブツリーに属する uuid。表示から除外する。
  const pruned = new Set<string>();
  // uuid のサブツリー (自身 + 全子孫) を pruned に入れる。循環 / 既訪問はガードする。
  const pruneSubtree = (rootUuid: string) => {
    const stack: string[] = [rootUuid];
    while (stack.length > 0) {
      const u = stack.pop();
      if (u === undefined || pruned.has(u)) continue;
      pruned.add(u);
      for (const child of childrenByParent.get(u) ?? []) stack.push(child.uuid);
    }
  };

  // 分岐点を検出する。同一会話的親に分岐候補が 2 つ以上並ぶ箇所が rewind 分岐。非選択候補のサブツリーを
  // 刈り、選択枝の先頭に branch イベントを用意する。処理順は結果に影響しない (各分岐点は独立に
  // 自分の非選択候補だけを刈り、pruned は冪等な集合のため)。
  for (const [ancestor, candidates] of convChildren) {
    if (candidates.length < 2) continue;
    // 選択: selection 指定が候補にあればそれ、無ければ最新 (出現順で最後)。
    let selected = candidates[candidates.length - 1];
    const sel = selection?.get(ancestor);
    if (sel !== undefined) {
      const found = candidates.find((c) => c.uuid === sel);
      if (found !== undefined) selected = found;
    }
    for (const cand of candidates) {
      if (cand.uuid !== selected.uuid) pruneSubtree(cand.uuid);
    }
    branchAtChild.set(selected.uuid, {
      kind: "branch",
      ts: selected.raw.timestamp ?? "",
      branchKey: ancestor,
      selectedChildUuid: selected.uuid,
      options: candidates.map((c, i) => ({
        childUuid: c.uuid,
        index: i + 1, // 古い順 1 始まり (最新が最大番号)
        lead: nodeLeadText(c.raw),
        ts: c.raw.timestamp ?? "",
      })),
    });
  }

  // --- フェーズ 3: 捨て枝以外をファイル順にイベント化する ---
  // pruned は uuid を持つレコードのみ含む。uuid 無し (古いログ / 注入) は常に表示される。
  for (const node of nodes) {
    if (pruned.has(node.uuid)) continue;
    totalLines++;
    // この行が分岐の選択枝の先頭なら、直前に branch セレクタを挿す。
    const branch = branchAtChild.get(node.uuid);
    if (branch !== undefined) events.push(branch);

    const raw = node.raw;
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
            // AskUserQuestion の応答なら ask イベントの answer を充填する。引き当ては
            // askById 優先 → toolById fallback の順 (同 tool_use_id が両方に居ることは無いが、
            // ask 経路を先に試すことで「ask に登録されているのに tool として処理する」誤りを防ぐ)。
            const ask = askById.get(block.tool_use_id);
            if (ask !== undefined) {
              const answers = parseAskAnswers(toolResultText(block.content));
              for (const q of ask.questions) {
                const a = answers.get(q.question);
                if (a !== undefined) q.answer = a;
              }
              continue;
            }
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
      // SDK 合成 assistant (model:"<synthetic>") は実応答ではなく整合性のための注入。
      // 例: `[{type:"text", text:"No response requested."}]` が同じ親 uuid に追記される。
      // transcript に載せると assistant バブルとして描画され、real 応答と兄弟で並ぶと branch
      // chooser まで生えるため、レコードごと skipped に倒す (block 走査自体を回避)。
      if (isSyntheticAssistant(raw)) {
        skipped++;
        continue;
      }
      // 実際に使われた model を記録する。content の形 (array / synthetic string) に依らず
      // message.model はレコード単位に付くため、ブロック走査の前にここで採る。null / 空 を
      // 除外する。`<synthetic>` 除外は上の `isSyntheticAssistant` 早期 return で 1 箇所 SSOT 化
      // 済みのため、ここではチェックしない (この経路に synthetic は到達しない)。
      const model = raw.message?.model;
      if (typeof model === "string" && model !== "" && !seenModels.has(model)) {
        seenModels.add(model);
        models.push(model);
      }
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
          // AskUserQuestion は通常の tool ではなく「assistant の質問 + user の回答」という
          // 会話構造として扱う (`kind: "ask"`)。input から質問列を取り出し、後続の
          // tool_result で answer を充填する。questions[] が空でも ask として描画する
          // (空質問の AskUserQuestion はそもそも来ないが、信頼境界外の防衛として握り潰さず可視化)。
          if (block.name === ASK_TOOL_NAME) {
            const ask: Extract<TranscriptEvent, { kind: "ask" }> = {
              kind: "ask",
              ts,
              toolUseId,
              questions: normalizeAskQuestions(block.input ?? {}),
            };
            if (toolUseId !== "") askById.set(toolUseId, ask);
            events.push(ask);
            continue;
          }
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

  return { events, models, totalLines, malformed, skipped, emptyThinking };
}

/**
 * ask イベントを「質問 = assistant 発言」「回答 = user 発言」のフラットな会話列に展開する
 * (terminal preview など、選択肢を出したくない consumer 向け)。answer が undefined の question
 * (resume 中断 / parse 失敗) は user メッセージを出さず、質問だけを残す。
 *
 * dialog 側 (SessionLogTranscript) は ask イベント本体を受け取って選択肢込みで描画するため、
 * この helper は使わない。consumer ごとに描画方針が違うので、parser 側の TranscriptEvent は
 * リッチな ask のまま残しつつ「会話列だけ欲しい」consumer 用に薄い変換を提供する形にする。
 */
export function flattenAskToMessages(
  events: TranscriptEvent[],
): Array<{ kind: "user" | "assistant"; text: string; ts: string }> {
  const out: Array<{ kind: "user" | "assistant"; text: string; ts: string }> = [];
  for (const ev of events) {
    if (ev.kind === "user" || ev.kind === "assistant") {
      out.push({ kind: ev.kind, text: ev.text, ts: ev.ts });
      continue;
    }
    if (ev.kind === "ask") {
      for (const q of ev.questions) {
        if (q.question !== "") out.push({ kind: "assistant", text: q.question, ts: ev.ts });
        if (q.answer !== undefined && q.answer !== "")
          out.push({ kind: "user", text: q.answer, ts: ev.ts });
      }
    }
  }
  return out;
}

// model ID の family 部分 → 表示名。バージョンは正規表現で抽出するため family のみ table 化する。
const MODEL_FAMILY_LABELS: Record<string, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

/**
 * model ID を短い表示名にする。`claude-opus-4-8` → `Opus 4.8`、
 * `claude-haiku-4-5-20251001` → `Haiku 4.5` (日付サフィックスは捨てる)。
 * 既知パターンに合わない値は生のまま返し、未知 model を握り潰さず可視化する。
 */
export function formatModelLabel(model: string): string {
  const match = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(model);
  if (match === null) return model;
  const [, family = "", major = "", minor = ""] = match;
  return `${MODEL_FAMILY_LABELS[family]} ${major}.${minor}`;
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
// (結果テキストの途中行に出るため)。wf id は `wf_` プレフィックス + 英数字 / ハイフン
// (許容文字クラスは正規表現本体の `[A-Za-z0-9-]` が SSOT。特定の桁数 / 基数は仮定しない)。
const WORKFLOW_RUN_ID_RE = /Run ID:\s*(wf_[A-Za-z0-9-]+)/;

/** groupByWorkflow が要求する最小情報。SessionTab / SubagentDescriptor 双方の射影。 */
export interface WorkflowGroupItem {
  id: string;
  workflowRunId: string;
  workflowName: string;
}

/** workflowRunId でまとめた 1 グループ。`agents` は入力の出現順を保つ (先頭がアンカー)。 */
export interface WorkflowGroup<T extends WorkflowGroupItem> {
  runId: string;
  name: string; // workflowName 優先、空なら runId
  agents: T[];
}

/**
 * workflow agent (`workflowRunId !== ""`) を workflowRunId ごとにグループ化する (出現順保持)。
 * 非 workflow subagent (`workflowRunId === ""`) は除外する。
 *
 * タブバーのグループ表示と Workflow 行リンクの両方がこの 1 関数を SSOT に使い、
 * 「グループ先頭 agent = リンク先 agent」の一貫性を構造的に保証する (グループ化条件を
 * 2 箇所に複製すると先頭の取り方が無言で乖離するため)。
 */
export function groupByWorkflow<T extends WorkflowGroupItem>(items: T[]): WorkflowGroup<T>[] {
  const groups = new Map<string, WorkflowGroup<T>>();
  for (const item of items) {
    if (item.workflowRunId === "") continue;
    const existing = groups.get(item.workflowRunId);
    if (existing === undefined) {
      groups.set(item.workflowRunId, {
        runId: item.workflowRunId,
        // 見出し名は workflowName 優先。空なら runId をそのまま見出しに使う。
        name: item.workflowName !== "" ? item.workflowName : item.workflowRunId,
        agents: [item],
      });
    } else {
      existing.agents.push(item);
    }
  }
  return [...groups.values()];
}

/**
 * subagent タブのラベル。phaseTitle / label を独立に評価し、両方あれば `phaseTitle · label`、
 * 片方だけならそれ単独で出す (workflow agent は phaseTitle、Task subagent は label が埋まる)。
 * どちらも空なら agentType、それも空なら agentId 先頭に倒す。
 *
 * phaseTitle と label は別ソース (workflowProgress の異なるフィールド) 由来で片方だけ埋まる
 * 状態を信頼境界外データとして排除できないため、AND 連結ではなく段階的に拾って情報落ちを防ぐ。
 */
export function subagentTabLabel(entry: {
  id: string;
  label: string;
  agentType: string;
  phaseTitle: string;
}): string {
  const parts: string[] = [];
  if (entry.phaseTitle !== "") parts.push(entry.phaseTitle);
  if (entry.label !== "") parts.push(entry.label);
  if (parts.length > 0) return parts.join(" · ");
  if (entry.agentType !== "") return entry.agentType;
  return entry.id.slice(0, 8);
}

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
  // 複数 subagent が同じ name を持つ場合、その name では一意に引けないので除外対象にする。
  const ambiguousNames = new Set<string>();
  for (const sub of subagents) {
    if (sub.parentToolUseId !== "") byParentToolUse.set(sub.parentToolUseId, sub);
    byAgentId.set(sub.id, sub);
    if (sub.name !== "") {
      if (byName.has(sub.name)) ambiguousNames.add(sub.name);
      else byName.set(sub.name, sub);
    }
  }
  // workflowRunId → グループ。タブバー表示と同じ groupByWorkflow を SSOT に使い、
  // 「グループ先頭 agent = Workflow 行リンク先」の一貫性を保つ。
  const byWorkflowRunId = new Map(groupByWorkflow(subagents).map((g) => [g.runId, g]));

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
    if (group === undefined) return undefined;
    const [first] = group.agents;
    if (first === undefined) return undefined;
    return { agentId: first.id, label: `${group.name} (${group.agents.length})` };
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

/** セッションの生存期間 (最初〜最後の有効 ts の epoch ms)。 */
export interface SessionTimeRange {
  startMs: number;
  endMs: number;
}

/**
 * events の最初〜最後の有効 ts を epoch ms で返す (横断タイムラインの生存期間バー算出)。
 *
 * tool イベントは result が後から充填される構造で ts が厳密な昇順とは限らないため、
 * 順序に依存せず全件の min / max を取る。有効 ts (Date.parse 可能) が 1 つも無ければ
 * undefined を返し、呼び出し側はそのセッションを時間軸に置けない (placeholder 扱い) と判断する。
 */
export function sessionTimeRange(events: TranscriptEvent[]): SessionTimeRange | undefined {
  let startMs: number | undefined;
  let endMs: number | undefined;
  for (const ev of events) {
    const t = Date.parse(ev.ts);
    if (Number.isNaN(t)) continue;
    if (startMs === undefined || t < startMs) startMs = t;
    if (endMs === undefined || t > endMs) endMs = t;
  }
  if (startMs === undefined || endMs === undefined) return undefined;
  return { startMs, endMs };
}

// --- 横断タイムラインのトラック組み立て (SessionLogDialog / SessionLogTimeline が使う純関数) ---

/** 横断タイムラインの 1 行。session 行 (main / subagent) と workflow グループ見出し行 (isHeader)。 */
export interface TimelineTrack {
  id: string;
  label: string;
  isMain: boolean;
  // workflow グループの見出し行。workflow 名を 1 回だけ出し、バーは持たず選択もできない。
  isHeader: boolean;
  // グループ配下の agent 行。ラベルを indent してグループ帰属を示す。
  indent: boolean;
  // gutter のアイコン種別。main / グループ配下 agent は無し。
  iconKind?: "workflow" | "subagent";
  // この agent が使った model 名 (出現順ユニーク)。gutter ラベルに添える。
  // workflow グループ見出し行 (isHeader) は agent ではないため常に空。
  models: string[];
  startMs: number | undefined;
  endMs: number | undefined;
}

/** buildTimelineTracks に渡す 1 セッションの最小情報 (生存期間は events から算出)。 */
export interface TimelineSession {
  id: string;
  label: string;
  events: TranscriptEvent[];
  // この agent が使った model 名 (ParsedSessionLog.models をそのまま渡す)。
  models: string[];
}

/** workflow グループ 1 つ (見出し名 + run id + 配下 agent)。 */
export interface TimelineWorkflowGroup {
  name: string;
  runId: string;
  agents: TimelineSession[];
}

// 開始時刻 (epoch ms) の比較。ts 不在 (undefined) は時系列に置けないため末尾へ寄せる。
function compareMaybeMs(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

function toSessionTrack(
  s: TimelineSession,
  opts: { isMain?: boolean; iconKind?: TimelineTrack["iconKind"]; indent?: boolean },
): TimelineTrack {
  const range = sessionTimeRange(s.events);
  return {
    id: s.id,
    label: s.label,
    isMain: opts.isMain ?? false,
    isHeader: false,
    indent: opts.indent ?? false,
    iconKind: opts.iconKind,
    models: s.models,
    startMs: range?.startMs,
    endMs: range?.endMs,
  };
}

/**
 * 横断タイムラインのトラック列を組み立てる。main を anchor として先頭固定し、subagent は
 * 並べ替え単位 (plain subagent 1 件 / workflow グループ 1 塊) ごとに最古開始時刻で古い順に並べる。
 * workflow は見出し行 (isHeader) + 配下 agent (内部も古い順) を 1 単位として contiguous に保つ。
 * 生存期間 ts を持たない (sessionTimeRange undefined) 単位 / agent は末尾へ寄せる (sort は安定)。
 */
export function buildTimelineTracks(input: {
  main: TimelineSession | undefined;
  plainSubagents: TimelineSession[];
  workflowGroups: TimelineWorkflowGroup[];
}): TimelineTrack[] {
  const tracks: TimelineTrack[] = [];
  if (input.main !== undefined) tracks.push(toSessionTrack(input.main, { isMain: true }));

  interface Unit {
    earliest: number | undefined;
    tracks: TimelineTrack[];
  }
  const units: Unit[] = [];
  // plain subagent: 1 トラック = 1 単位。
  for (const s of input.plainSubagents) {
    const track = toSessionTrack(s, { iconKind: "subagent" });
    units.push({ earliest: track.startMs, tracks: [track] });
  }
  // workflow グループ: 見出し行 + 配下 agent (古い順) を 1 単位にまとめる。
  for (const group of input.workflowGroups) {
    const agentTracks = group.agents
      .map((s) => toSessionTrack(s, { indent: true }))
      .sort((a, b) => compareMaybeMs(a.startMs, b.startMs));
    const starts = agentTracks.map((t) => t.startMs).filter((m): m is number => m !== undefined);
    const header: TimelineTrack = {
      id: group.runId,
      label: group.name,
      isMain: false,
      isHeader: true,
      indent: false,
      iconKind: "workflow",
      models: [],
      startMs: undefined,
      endMs: undefined,
    };
    units.push({
      earliest: starts.length > 0 ? Math.min(...starts) : undefined,
      tracks: [header, ...agentTracks],
    });
  }

  units.sort((a, b) => compareMaybeMs(a.earliest, b.earliest));
  for (const unit of units) tracks.push(...unit.tracks);
  return tracks;
}

/** 全トラックを覆う共通時間軸 (有効 ts を持つトラックの min start / max end)。無ければ undefined。 */
export function timelineAxisRange(tracks: TimelineTrack[]): SessionTimeRange | undefined {
  let startMs: number | undefined;
  let endMs: number | undefined;
  for (const t of tracks) {
    if (t.startMs === undefined || t.endMs === undefined) continue;
    if (startMs === undefined || t.startMs < startMs) startMs = t.startMs;
    if (endMs === undefined || t.endMs > endMs) endMs = t.endMs;
  }
  if (startMs === undefined || endMs === undefined) return undefined;
  return { startMs, endMs };
}

/** タイムライン最下段 (= 最新) の subagent トラック id。末尾から最初の非 header・非 main を返す。 */
export function newestSubagentTrackId(tracks: TimelineTrack[]): string | undefined {
  for (let i = tracks.length - 1; i >= 0; i--) {
    const track = tracks[i];
    if (!track.isHeader && !track.isMain) return track.id;
  }
  return undefined;
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
