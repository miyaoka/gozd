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
// attachment は原則 skipped だが、`queued_command` (エージェント作業中に queue に積まれた
// 会話ターン) だけは例外で、本文が `type:"user"` に昇格せず attachment.prompt にしか残らない
// ことがあるため会話イベントにする。queue に積む主体はユーザーに限らない。採否と話者は上流が
// 分類済みの attachment.commandMode と attachment.origin で決める (queuedCommandSpeaker)。
//
// ユーザーの中断 (Esc) は Claude Code が `type:"user"` のマーカー行として書く。発話ではないため
// interrupt イベントにし、分岐候補にもしない (判定は isInterruptMarker)。
//
// system 注入の可視化 (`kind:"system"`): エージェントのコンテキストに注入されたシステム由来
// テキストを system イベントとして載せる。ソースは hook 由来 attachment
// (`hook_success` / `hook_additional_context`) で、SessionStart hook の出力等、実行時に
// system-reminder としてエージェントに届く content の永続化形。content 空の hook_success
// (発火記録だけの PreToolUse 等が大半) は表示する中身が無いため skipped。
// なお output_style / task_reminder 等のランタイムリマインダは JSONL に永続化されず、原理的に
// 表示できない。harness 追記の `<system-reminder>` (tool call バッチ推奨 / truncation 通知等) は
// tool_result の content 内に現れ、tool イベントの result.text に全文が載るため抽出しない
// (追記と「file 本文がたまたまタグ文字列を含む」偶発一致を区別する構造的マーカーが無い)。
//
// compact 要約 (`isCompactSummary`) は user イベントにする。compact 後のエージェントは要約を
// user role の発言として受け取り、それを起点に会話を続けるため。
//
// 平文の無い thinking (暗号化 signature のみ / フィールド欠落) も載せないが、
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
//
// compact も rewind ではない。compact は parentUuid:null の `compact_boundary` を書き、その子に
// 要約を置く。compact 後の会話は、要約の下に続く形と、要約を経ず compact 前の末尾に直接繋がる形の
// 両方が実ログにある。前者は物理的な親のままだとセッション先頭と同じ ROOT に並ぶため、boundary を
// logicalParentUuid で compact 前の末尾に繋ぐ (treeParentUuid)。後者は繋いだ結果、要約と compact
// 後の最初の応答が同じ会話的親に並ぶため、要約を分岐候補にしない (isCompactSummary)。手動 compact は
// 入力した `/compact` を compact 前の末尾と要約の下に重複して書き、繋いだ結果この 2 つも同じ会話的親に
// 並ぶ。後の方は元の入力の別名 (echo) として候補から外し、表示もしない (withoutEchoes)。

import { tryCatch } from "@gozd/shared";

/** content ブロック (Anthropic Messages API スキーマ) */
interface TextBlock {
  type: "text";
  text: string;
}
interface ThinkingBlock {
  type: "thinking";
  // 信頼境界外の入力。平文を残さず空文字を書くレコードがあり、フィールド自体が欠落する
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
  // Anthropic Messages API の image source。base64 のみ下流で利用できる。
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
  };
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

// ログファイルは外部プロセス (Claude Code) が書く信頼境界外の入力。media_type を
// 既知の画像 MIME ホワイトリストで検証し、外れたら undefined に倒す。未知 / 破損 MIME を
// 無検証で下流に通さず、挙動を決定的にする。
const ALLOWED_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * 検証済みの画像ソース (既知 MIME + base64 データ)。`data:` URL 等の表示ターゲット固有の
 * 組み立ては consumer (view) の責務なので、parse はここまで (検証済みの生データ) を載せる。
 */
export interface ImageSource {
  mediaType: string;
  base64: string;
}

/** image block を検証済み ImageSource にする。既知 MIME の base64 source 以外は undefined。 */
function imageSource(block: ImageBlock): ImageSource | undefined {
  const source = block.source;
  if (source === undefined) return undefined;
  if (
    source.type === "base64" &&
    source.media_type !== undefined &&
    source.data !== undefined &&
    ALLOWED_IMAGE_MEDIA_TYPES.has(source.media_type)
  ) {
    return { mediaType: source.media_type, base64: source.data };
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
// queued_command の `attachment.origin`。kind ごとの意味 (実ログで確認済み):
// - "human": ユーザーの入力
// - "auto-continuation": 作業中に打った /goal を harness が `Goal set: <条件>` として積んだもの
// - "task-notification": バックグラウンドタスクの完了通知
// - "peer": 他のエージェントからのメッセージ。このセッションの subagent (hand-back 報告と
//   SendMessage) は senderTaskId を持ち、他セッションからの cross-session メッセージは持たない
interface RawQueueOrigin {
  kind?: unknown;
  senderTaskId?: unknown;
  name?: unknown;
  // hand-back は subagent id、cross-session はソケットパス。
  from?: unknown;
  // ラッパータグを含まないメッセージ本文。
  body?: unknown;
}
// `type:"attachment"` レコードの中身。queued_command (会話) と hook 系 (system 注入) を読む。
interface RawAttachment {
  type?: string;
  // queued_command が積んだ本文。`message.content` と同じ shape を取り、テキストのみなら
  // string、画像添付があると ContentBlock[] (text + image) になる。信頼境界外の入力なので
  // optional。string と決め打ちすると画像添付時に配列が text に流れ込み base64 が生露出する。
  prompt?: string | ContentBlock[];
  // queue 種別。"prompt" = 会話ターンとして積まれた本文 / "task-notification" = 注入通知。
  // "prompt" はユーザーの生発話に限らないため、話者は origin で判定する。
  commandMode?: string;
  // queue に積んだ主体。origin を持たないレコードは commandMode:"prompt" をユーザーの入力にだけ
  // 使う形式 (実ログで確認済み)。
  origin?: RawQueueOrigin | null;
  // hook 系 attachment の発火元 hook 名 (例 "SessionStart:startup" / "PreToolUse:Bash")。
  // system イベントの label に使う。
  hookName?: string;
  // hook が注入した content。`hook_success` は string (実ログで確認済み。大半は空 = 発火記録
  // だけで注入なし)、`hook_additional_context` は string[] (実ログで確認済み)。queued_command
  // の prompt とは別フィールド。信頼境界外なので shape ごと typeof で検証して使う。
  content?: string | string[];
}
// AskUserQuestion 応答の raw line top-level に乗る構造化フィールド。Claude Code が
// 組み立てた `question 文字列 → answer 文字列` の Map を `answers` に持つ。
// tool_result.content の自然言語テキスト (`"Q"="A"` 形式) はこの Map と等価情報の表現で、
// 文字列内部に `"` を含むケースで regex 復元が壊れる。`answers` を直接読めば LLM 出力の
// 任意 char 集合に依存せず構造的に取れるので、AskUserQuestion の answer 充填はこれを SSOT に使う。
interface RawToolUseResult {
  answers?: Record<string, string>;
  // Agent tool (subagent_type 経由の通常 spawn) の spawn 結果に乗る、spawn 先 subagent 自身の
  // 物理 id。ファイル名 `agent-<agentId>.jsonl` と厳密一致し、spawn ごとに一意 (実ログで確認済み:
  // meta.json に toolUseId を持たない spawn パターンでもこのフィールドは存在した)。team teammate
  // (Agent tool を `name` 付きで呼ぶ経路) の spawn 結果にはこのフィールドが無く、代わりに
  // `agent_id`/`name` という衝突しうるラベルしか載らない (実ログで確認済み)。
  agentId?: string;
}
interface RawLine {
  type?: string;
  timestamp?: string;
  message?: RawMessage;
  attachment?: RawAttachment;
  // tool_result block の親 line に同居する構造化結果。AskUserQuestion 応答時のみ
  // `answers` が埋まる (他 tool では未使用)。型は AskUserQuestion 用途に絞って薄く宣言する。
  toolUseResult?: RawToolUseResult;
  // CLI / hook が注入したシステム由来レコード。ユーザー発話ではないので transcript に載せない。
  isMeta?: boolean;
  // レコードの一意 id と親 id。Claude Code は append-only に書き、rewind 時は過去の uuid を
  // parentUuid に指して新レコードを追記する (旧枝は消さない)。このため uuid/parentUuid の木に
  // 分岐が生じ、「現在の会話」は tip から遡る 1 本道になる。rewind 検出の唯一の情報源。
  // 古いログ / 注入レコードは uuid を持たない (型で排除できないため optional)。parentUuid は
  // ルートで null になりうる。
  uuid?: string;
  parentUuid?: string | null;
  // parentUuid を null にして物理的な鎖を切ったレコードが持つ、会話上の本当の親。compact 時の
  // `compact_boundary` がこれを持ち、compact 前の会話の末尾を指す (実ログで確認済み)。
  logicalParentUuid?: string | null;
  // compact 時に Claude Code が書く要約メッセージ (`type:"user"`)。人間が打った発話ではないが、
  // compact 後のエージェントには user role の発言として渡る。
  isCompactSummary?: boolean;
  // coordinator (親エージェント) が SendMessage で subagent に中継した発話の出所。Claude Code が
  // 中継時に `origin.kind:"coordinator"` を付ける。中継は `isMeta:true` と併記されるため、これが
  // 無いと CLI/hook 注入レコードと区別できず会話から落ちる。中継発話を救済する判別キー。
  origin?: { kind?: string };
  // Claude Code が 1 回のユーザープロンプト処理サイクルに採番する UUID。tool_use 単位ではなく
  // 「そのプロンプト処理中に呼んだ全 tool の呼び出し」単位で共有されるため、1 回の応答で
  // 複数 tool を呼べば (並列呼び出しに限らず、同一プロンプト内の逐次呼び出しも含め) それら
  // 全ての tool_result が同じ promptId を持つ (実ログで確認済み: 1 promptId を最大 32 件の
  // tool_result が共有していた)。spawn ごとに一意ではないため、team teammate の spawn 解決
  // (`gozd` の buildSubagentLinks) では「同一 promptId を複数 subagent が共有していないか」を
  // 検査した上でのみ使える鍵になる (`toolUseResult.agentId` が使える通常 spawn では不要)。
  promptId?: string;
  // このレコードを書いた Claude Code のバージョン (例 "2.1.178")。行ごとに付くため、セッション中の
  // auto-update で複数値になりうる。UI のバージョン表示に出現順ユニークで集める。
  version?: string;
}

// harness / CLI が user role で注入するラッパーで始まる string。これらはユーザーの
// 生発話ではない (ローカルコマンド出力 / バックグラウンドタスク完了通知) ため
// user イベントにしない。
//
// `type:"user"` + content=string + isMeta:null の形で main loop に注入されるため、
// isMeta フラグでは区別できず、先頭ラッパータグで判定する。実ユーザー発話はこれらの
// タグで始まらない。`<system-reminder>` が user string の先頭に現れる形は存在しない
// (harness 追記は tool_result content 内、生発話には語としての言及・埋め込みのみで、
// いずれも先頭一致しない。ファイル冒頭の module doc 参照)。
const INJECTED_USER_WRAPPER_RE =
  /^\s*<(local-command-stdout|local-command-stderr|task-notification)>/;
function isInjectedUserText(text: string): boolean {
  return INJECTED_USER_WRAPPER_RE.test(text);
}

/**
 * coordinator (親エージェント) が SendMessage で subagent に中継した発話か。Claude Code は中継を
 * `isMeta:true` で記録するが、これは CLI/hook 注入レコードと同じフラグで会話から落ちてしまう。
 * 中継には `origin.kind:"coordinator"` が併記される (2.1.178 で導入。それ以前は isMeta なしの生
 * 発話として記録され区別不要だった) ため、これを判別キーにして isMeta filter から救済する。
 * subagent にとっては応答対象の会話ターンなので、生発話と同じく user イベント / branch 候補に載せる。
 */
function isCoordinatorMessage(raw: RawLine): boolean {
  return raw.type === "user" && raw.origin?.kind === "coordinator";
}

/** queued_command の話者。"hidden" は会話に載せず skipped に計上する。 */
type QueuedCommandSpeaker =
  | { speaker: "user" }
  | { speaker: "teammate"; from: string; text: string }
  | { speaker: "hidden" };

const USER: QueuedCommandSpeaker = { speaker: "user" };
const HIDDEN: QueuedCommandSpeaker = { speaker: "hidden" };

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * このセッションの subagent からのメッセージは sub 側の transcript で読めるため main には
 * 出さない。他セッションからのメッセージは読める場所が他に無いため teammate として出す。
 */
function peerSpeaker(origin: RawQueueOrigin): QueuedCommandSpeaker {
  if (origin.senderTaskId !== undefined) return HIDDEN;
  const text = stringOrUndefined(origin.body) ?? "";
  if (text === "") return HIDDEN;
  const from = stringOrUndefined(origin.name) ?? stringOrUndefined(origin.from) ?? "";
  return { speaker: "teammate", from, text };
}

// origin.kind → 話者。表に無い kind (kind 欠落を含む) は hidden に倒す: 話者を偽って表示する
// より、skipped に計上して件数で観察できる方が誤りが小さい。kind は信頼境界外の文字列なので、
// prototype のメンバー名が当たらないよう Map で引く。
const QUEUED_COMMAND_SPEAKER_BY_KIND = new Map<
  string,
  (origin: RawQueueOrigin) => QueuedCommandSpeaker
>([
  ["human", () => USER],
  // 待機中に打った /goal と同じくユーザーの発言として出す。
  ["auto-continuation", () => USER],
  ["peer", peerSpeaker],
]);

function queuedCommandSpeaker(attachment: RawAttachment): QueuedCommandSpeaker {
  const origin = attachment.origin;
  if (origin === undefined) return USER;
  if (typeof origin !== "object" || origin === null) return HIDDEN;
  const kind = stringOrUndefined(origin.kind);
  const resolve = kind === undefined ? undefined : QUEUED_COMMAND_SPEAKER_BY_KIND.get(kind);
  return resolve === undefined ? HIDDEN : resolve(origin);
}

// 中継ラッパーの前後の定型句。本文はこの 2 つに挟まれる。Claude Code が中継 string を
// `<LEAD><本文><TRAIL>…注意書き` の形で組み立てる。
const COORDINATOR_LEAD = "The coordinator sent a message while you were working:\n";
const COORDINATOR_TRAIL = "\n\nAddress this before completing your current task.";

/**
 * coordinator 中継 string からラッパーを剥がし本文だけ取り出す。旧 (生発話) 形式と同じ「中継本文
 * だけを表示」に揃えるための正規化。前後の定型句が一致しない (将来 Claude Code が書式を変えた等)
 * 場合は raw をそのまま返し、内容を絶対に落とさない (silent drop 回避)。
 */
function coordinatorInnerText(content: string): string {
  let text = content;
  if (text.startsWith(COORDINATOR_LEAD)) text = text.slice(COORDINATOR_LEAD.length);
  const trail = text.indexOf(COORDINATOR_TRAIL);
  if (trail !== -1) text = text.slice(0, trail);
  const trimmed = text.trim();
  return trimmed === "" ? content : trimmed;
}

// team 機能で peer Claude セッションが送り合う <teammate-message> ラッパー。`isMeta:null` の user
// string として記録されるため isMeta filter では落ちず、ラッパー (前置き / 開閉タグ / 末尾の
// IMPORTANT 注意書き) が生のまま本文に混ざる。1 つの user レコードに複数ブロックが入りうる。
const TEAMMATE_BLOCK_RE = /<teammate-message([^>]*)>\n?([\s\S]*?)\n?<\/teammate-message>/g;
const TEAMMATE_ID_RE = /teammate_id="([^"]*)"/;
const TEAMMATE_SUMMARY_RE = /summary="([^"]*)"/;

/** teammate-message ラッパーを含む user string か。タグの有無だけで判定する。 */
function isTeammateMessageText(content: string): boolean {
  return content.includes("<teammate-message");
}

/** trim 後の text が JSON object か。idle_notification 等のシステム通知ブロックを会話から除く判定に使う。 */
function isJsonObjectText(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  const r = tryCatch(() => JSON.parse(t) as unknown);
  return r.ok && typeof r.value === "object" && r.value !== null;
}

/** 1 つの <teammate-message> ブロックの構造データ (表示は consumer に委ねる)。 */
interface TeammateBlock {
  from: string;
  summary: string;
  text: string;
}

/**
 * teammate-message string から各ブロックを構造データとして取り出す。前置き ("Another Claude
 * session sent a message:") / 末尾の IMPORTANT 注意書きは本文外なので自然に落ちる。本文が空 /
 * システム通知 JSON (idle_notification 等) のブロックは会話でないため除外する。
 *
 * `matchedCount` (正規表現で `<...>...</...>` ペアが取れた総数) と `blocks` (会話として採用した
 * ブロック) を区別して返す。呼び出し側は両者で raw fallback の発火条件を分ける必要がある:
 *   - matchedCount === 0: タグ文字列はあるがペアが取れない (誤検出 / 壊れた書式) → raw を出す
 *   - matchedCount > 0 かつ blocks 空: ペアは取れたが全ブロック除外 (idle_notification 等) →
 *     会話でないので skip。ここで raw を出すと「隠すべき通知」を前置き・脚注ごと丸出しにする
 */
function parseTeammateBlocks(content: string): { matchedCount: number; blocks: TeammateBlock[] } {
  const blocks: TeammateBlock[] = [];
  let matchedCount = 0;
  for (const m of content.matchAll(TEAMMATE_BLOCK_RE)) {
    matchedCount++;
    const [, attrs = "", rawBody = ""] = m;
    const text = rawBody.trim();
    if (text === "" || isJsonObjectText(text)) continue;
    blocks.push({
      from: TEAMMATE_ID_RE.exec(attrs)?.[1] ?? "",
      summary: TEAMMATE_SUMMARY_RE.exec(attrs)?.[1] ?? "",
      text,
    });
  }
  return { matchedCount, blocks };
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

/**
 * compact の要約メッセージか。要約は user イベントとして載せるが、分岐候補にはしない。
 * compact 後の会話が compact 前の末尾に直接繋がる形では、boundary を論理的な親で繋ぐと要約と
 * compact 後の最初の応答が同じ会話的親に並ぶ。要約を候補に含めると rewind と誤検出し、偽の分岐
 * セレクタを出して既定では要約を刈る。
 */
function isCompactSummary(raw: RawLine): boolean {
  return raw.type === "user" && raw.isCompactSummary === true;
}

// ユーザーが Esc で応答を中断したとき Claude Code が書くマーカーの文言。Claude Code 本体が定数として
// 持つ固定文字列で、生成中の応答を止めたときと tool の実行を止めたときの 2 種がある。
const INTERRUPT_MARKER_TEXTS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

/**
 * ユーザーの中断を記録したマーカーか。マーカーは `type:"user"` の content 配列に text 1 ブロックだけを
 * 持ち、その全文が固定文言と一致する。同じ文字列を人間が打つと content は string で記録されるため、
 * 本文だけでは区別できず、配列の形との AND で判定する。マーカーを示す専用フラグは無い
 * (`interruptedMessageId` は付かないマーカーがある)。
 */
function isInterruptMarker(raw: RawLine): boolean {
  if (raw.type !== "user") return false;
  const content = raw.message?.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const [block] = content;
  return block?.type === "text" && INTERRUPT_MARKER_TEXTS.has(block.text);
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
 * - 先頭が注入ラッパー (ローカルコマンド出力 / task-notification) → 除外。branch 候補
 *   判定 (isBranchCandidate) は本関数を使うため、注入ラッパーは候補にならない
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
  // エージェントのコンテキストに注入されたシステム由来テキスト。ソースは hook 由来
  // attachment (hook_success / hook_additional_context)。label は注入元の hook 名。
  // 会話ターンではないので branch 候補 / scroll-spy の観測対象にはしない。
  | { kind: "system"; label: string; text: string; ts: string }
  | {
      kind: "tool";
      name: string;
      input: Record<string, unknown>;
      toolUseId: string;
      ts: string;
      // agentId: tool_result の toolUseResult に乗る、spawn 先 subagent 自身の物理 id
      // (Agent tool の通常 spawn のみ非空)。promptId: tool_result を運ぶ生レコードの promptId
      // (team teammate spawn 解決の鍵。1 プロンプト処理サイクル単位で複数 tool_result にまたがり
      // うるため、呼び出し側で一意性を検査した上で使うこと)。どちらも gozd の buildSubagentLinks
      // が使う。tool_result 欠落時は undefined。
      result: { text: string; isError: boolean; agentId: string; promptId: string } | undefined;
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
  | { kind: "image"; ts: string; source: ImageSource | undefined }
  // ユーザーが Esc で応答を中断した位置。本文は固定文言なので持たない。会話ターンではないので
  // branch 候補にしない。
  | { kind: "interrupt"; ts: string }
  // team 機能で他の Claude セッション (peer) が <teammate-message> で送ってきた発話。`from` は
  // teammate_id、`summary` は peer 自身が付けた 1 行要約 (空のことがある)、`text` は本文。1 つの
  // user レコードに複数ブロックが入りうるため、ブロックごとに 1 イベント。見出しの組み方や
  // 色付けは表示ターゲット依存なので consumer (view) に委ね、parse は構造データだけ載せる。
  | { kind: "teammate"; ts: string; from: string; summary: string; text: string }
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
  /**
   * このセッションを書いた Claude Code のバージョンを出現順ユニークで持つ。行ごとの `version` が
   * SSOT。auto-update でセッション途中に上がると複数値になりうるため配列で保持する。
   */
  versions: string[];
  /**
   * この JSONL の先頭レコードの promptId。subagent ファイルの先頭レコードは spawn 元の
   * promptId を引き継ぐため、team teammate 等 meta.json に toolUseId を持たない spawn 経路で
   * main 側 tool_result.promptId と照合する鍵になる (gozd の buildSubagentLinks が使う)。
   * ただし promptId は spawn 単位ではなく1回のプロンプト処理サイクル単位の id のため、同一
   * サイクル内で複数 subagent が spawn されると値を共有しうる (一意性は保証しない。呼び出し側で
   * 衝突を検査すること)。先頭レコードが promptId を持たなければ空文字。
   */
  rootPromptId: string;
  /** 表示した (live な) JSONL 行数。rewind で選ばれなかった枝の行は含まない */
  totalLines: number;
  /** JSON parse に失敗した行数 (末尾の追記途中行など) */
  malformed: number;
  /**
   * transcript に載せなかったレコード数。attachment / system 等の非会話レコードと、元の入力が
   * 表示済みの重複入力 (echo。withoutEchoes) を含む
   */
  skipped: number;
  /**
   * 平文が無く載せなかった thinking ブロック数。会話イベントだが表示できる中身が無い
   * (暗号化 signature だけが書かれ thinking は空 / 欠落)。非会話レコードの
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

/**
 * user content 配列の 1 ブロックを transcript イベントにする。content 配列は通常の
 * `message.content` と queued_command の `attachment.prompt` の 2 経路に現れ、どちらでも
 * text → user / image → image の対応は同一。ここに一元化し「一方だけ image 分離を欠く」
 * 非対称バグ (base64 が text に生露出する類) を構造的に防ぐ。
 *
 * tool_result は実 user メッセージにしか現れず ask / tool 充填という別ロジック (askById /
 * toolById への副作用) なのでこの helper の責務外。呼び出し側が先に処理する。text / image
 * 以外は undefined を返し、呼び出し側が skipped 計上する (silent drop 禁止の観察可能性は
 * 呼び出し側に残す)。
 */
function userArrayBlockEvent(block: ContentBlock, ts: string): TranscriptEvent | undefined {
  if (block.type === "text") return { kind: "user", text: block.text, ts };
  if (block.type === "image") return { kind: "image", ts, source: imageSource(block) };
  return undefined;
}

/** branchKey (分岐点 = 候補が共有する親 uuid) → 選択した childUuid。未指定の分岐点は最新枝を採る。 */
export type BranchSelection = Map<string, string>;

/** parse 済みの 1 行 (rewind 木の構築に使う最小情報)。 */
interface LogNode {
  raw: RawLine;
  uuid: string; // raw.uuid ?? "" (uuid 無し = 木に参加しない古いログ / 注入レコード)
  parentUuid: string; // treeParentUuid(raw)
}

/**
 * rewind 木で使う親 uuid。parentUuid が string ならそれ、string でなければ logicalParentUuid、
 * どちらも無ければ "" (ROOT)。compact は `compact_boundary` の parentUuid を null にして新しい根を
 * 作る。物理的な根のまま扱うと、要約の下に続く compact 後の会話がセッション先頭と同じ ROOT に並んで
 * rewind と誤検出する。論理的な親で繋ぐと compact 前後が 1 本の会話になる。
 * raw は実行時型を保証しないため typeof で string を確認する。
 */
function treeParentUuid(raw: RawLine): string {
  if (typeof raw.parentUuid === "string") return raw.parentUuid;
  if (typeof raw.logicalParentUuid === "string") return raw.logicalParentUuid;
  return "";
}

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
  if (isSyntheticAssistant(raw) || isCompactSummary(raw) || isInterruptMarker(raw)) return false;
  const content = raw.message?.content;
  if (raw.type === "user") {
    // coordinator 中継は isMeta:true だが subagent にとっては会話ターンなので候補に含める。
    if (raw.isMeta === true && !isCoordinatorMessage(raw)) return false;
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

/**
 * node が original と同じ 1 回の入力を別の箇所に書き直したもの (echo) か。手動 compact は入力した
 * `/compact` を compact 前の末尾と要約の下の両方に書き、両者は同じ promptId と同じ本文 (後者は
 * command block で、userTextOf で正規化すると一致する) を持つ (実ログで確認済み)。
 *
 * promptId はプロンプト処理サイクル単位の id で、同じサイクルに積まれた別の発話も共有しうる。
 * このため promptId だけでなく本文全体の一致まで要求する。rewind で打ち直した発話は別のサイクルに
 * なるため echo にならない。
 *
 * 比べるのは string content 同士に限る。echo は両方とも string で書かれる。本文の比較に
 * nodeLeadText (分岐セレクタの見出し) を使わないのは、配列 content の先頭 text や
 * teammate-message の summary しか返さず、本文の違う発話まで一致させてしまうため。
 */
function isEchoOf(node: LogNode, original: LogNode): boolean {
  if (node.raw.type !== "user" || original.raw.type !== "user") return false;
  const promptId = node.raw.promptId;
  if (typeof promptId !== "string" || promptId === "" || promptId !== original.raw.promptId) {
    return false;
  }
  const content = node.raw.message?.content;
  const originalContent = original.raw.message?.content;
  if (typeof content !== "string" || typeof originalContent !== "string") return false;
  const text = userTextOf(content);
  return text !== undefined && text === userTextOf(originalContent);
}

/**
 * 同一分岐点の候補から echo (isEchoOf) を除き、残した元の入力の uuid → echo の uuid 列を
 * `echoesOf` に積む。echo を候補に残すと偽の分岐セレクタが出て、古い側を選ぶと compact 後の会話が
 * 丸ごと刈られる。echo は元の入力の別名として扱い、元の入力の枝が捨てられるときは echo の
 * サブツリーも一緒に捨てる。
 *
 * 先に出た方を残すのは、compact 前に書かれた入力が要約より前に並び、「指示 → 要約」の順で読めるため。
 */
function withoutEchoes(candidates: LogNode[], echoesOf: Map<string, string[]>): LogNode[] {
  const kept: LogNode[] = [];
  for (const cand of candidates) {
    const original = kept.find((k) => isEchoOf(cand, k));
    if (original === undefined) {
      kept.push(cand);
      continue;
    }
    const echoes = echoesOf.get(original.uuid);
    if (echoes === undefined) echoesOf.set(original.uuid, [cand.uuid]);
    else echoes.push(cand.uuid);
  }
  return kept;
}

/**
 * 分岐候補ノードの先頭テキスト (選択肢の識別ラベル)。空なら ""。表示上の切り詰めは consumer の
 * 責務 (view が CSS truncate + title で全文 hover を出す) なので、ここでは全文を返す。
 */
function nodeLeadText(raw: RawLine): string {
  const content = raw.message?.content;
  let text = "";
  if (typeof content === "string") {
    if (raw.type !== "user") {
      text = content;
    } else if (isTeammateMessageText(content)) {
      // teammate-message はラッパーを剥がし summary 優先 / 無ければ本文を lead に。本体の 3 分岐と
      // 対称化する: ペア未マッチ (非タグ生発話) は raw が正しい lead、全ブロック除外 (本体は skip)
      // は lead も空に倒し raw を漏らさない。
      const { matchedCount, blocks } = parseTeammateBlocks(content);
      const [first] = blocks;
      if (first !== undefined) text = first.summary !== "" ? first.summary : first.text;
      else text = matchedCount === 0 ? content : "";
    } else if (isCoordinatorMessage(raw)) {
      // coordinator 中継はラッパーを剥がした本文を lead にする。
      text = coordinatorInnerText(content);
    } else {
      text = userTextOf(content) ?? "";
    }
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text") {
        text = block.text;
        break;
      }
    }
  }
  return text.trim();
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
  // Claude Code のバージョンを出現順ユニークで集める。auto-update でセッション途中に変わると
  // 複数値になりうるため配列で保持する。seen は重複判定、versions は順序保持。
  const versions: string[] = [];
  const seenVersions = new Set<string>();

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
    nodes.push({ raw, uuid: raw.uuid ?? "", parentUuid: treeParentUuid(raw) });
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

  // 元の入力の uuid → その echo の uuid 列 (withoutEchoes)。echo は分岐候補にも表示にも使わない。
  const echoesOf = new Map<string, string[]>();

  // 分岐点を検出する。同一会話的親に分岐候補が 2 つ以上並ぶ箇所が rewind 分岐。非選択候補のサブツリーを
  // 刈り、選択枝の先頭に branch イベントを用意する。処理順は結果に影響しない (各分岐点は独立に
  // 自分の非選択候補だけを刈り、pruned は冪等な集合のため)。
  for (const [ancestor, siblings] of convChildren) {
    const candidates = withoutEchoes(siblings, echoesOf);
    if (candidates.length < 2) continue;
    // 選択: selection 指定が候補にあればそれ、無ければ最新 (出現順で最後)。
    let selected = candidates[candidates.length - 1];
    const sel = selection?.get(ancestor);
    if (sel !== undefined) {
      const found = candidates.find((c) => c.uuid === sel);
      if (found !== undefined) selected = found;
    }
    for (const cand of candidates) {
      if (cand.uuid === selected.uuid) continue;
      pruneSubtree(cand.uuid);
      for (const echo of echoesOf.get(cand.uuid) ?? []) pruneSubtree(echo);
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

  const echoes = new Set([...echoesOf.values()].flat());

  // --- フェーズ 3: 捨て枝以外をファイル順にイベント化する ---
  // pruned は uuid を持つレコードのみ含む。uuid 無し (古いログ / 注入) は常に表示される。
  for (const node of nodes) {
    if (pruned.has(node.uuid)) continue;
    totalLines++;
    // 重複した入力は元の入力が表示済み。子孫は刈らず、この行だけを落とす。
    if (echoes.has(node.uuid)) {
      skipped++;
      continue;
    }
    // この行が分岐の選択枝の先頭なら、直前に branch セレクタを挿す。
    const branch = branchAtChild.get(node.uuid);
    if (branch !== undefined) events.push(branch);

    const raw = node.raw;
    const ts = raw.timestamp ?? "";

    // Claude Code のバージョンを記録する。レコード種別に依らず行ごとに付くため、ここで採る。
    if (typeof raw.version === "string" && raw.version !== "" && !seenVersions.has(raw.version)) {
      seenVersions.add(raw.version);
      versions.push(raw.version);
    }

    // CLI / hook 注入のシステムレコードはユーザー発話ではないので会話に載せない。ただし
    // coordinator (親) が SendMessage で中継した発話 (isMeta:true + origin.kind:"coordinator") は
    // subagent にとって会話ターンなので除外しない。
    if (raw.isMeta === true && !isCoordinatorMessage(raw)) {
      skipped++;
      continue;
    }

    // compact 要約は compact 後のエージェントが user role の発言として受け取る本文なので、user
    // イベントにする (実ログでは content は string)。分岐候補にはしない (isBranchCandidate)。
    if (isCompactSummary(raw)) {
      const content = raw.message?.content;
      if (typeof content === "string" && content !== "") {
        events.push({ kind: "user", text: content, ts });
      } else {
        skipped++;
      }
      continue;
    }

    // 中断マーカーは type:"user" だがユーザー発話ではない。中断が起きた位置として載せる。
    if (isInterruptMarker(raw)) {
      events.push({ kind: "interrupt", ts });
      continue;
    }

    if (raw.type === "user") {
      const content = raw.message?.content;
      if (typeof content === "string") {
        // teammate-message (peer セッションからの発話) はブロックごとに teammate イベントへ。
        // raw fallback の条件は matchedCount で分ける: ペアが 1 つも取れない (誤検出 / 壊れた
        // 書式) ときだけ raw を user に出し silent drop を避ける。ペアは取れたが全ブロックが
        // システム通知 JSON 等で除外された場合は会話でないので skip する (raw を出すと隠すべき
        // 通知を前置き・脚注ごと丸出しにしてしまう)。
        if (isTeammateMessageText(content)) {
          const { matchedCount, blocks } = parseTeammateBlocks(content);
          if (matchedCount === 0) {
            events.push({ kind: "user", text: content, ts });
          } else if (blocks.length === 0) {
            skipped++;
          } else {
            for (const b of blocks) {
              events.push({ kind: "teammate", ts, from: b.from, summary: b.summary, text: b.text });
            }
          }
          continue;
        }
        // coordinator 中継はラッパーを剥がして本文を出す。それ以外は slash command をコマンド名に
        // し、task-notification 等の注入 string を除外する。
        const text = isCoordinatorMessage(raw)
          ? coordinatorInnerText(content)
          : userTextOf(content);
        if (text === undefined) {
          skipped++;
          continue;
        }
        events.push({ kind: "user", text, ts });
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            // AskUserQuestion の応答なら ask イベントの answer を充填する。引き当ては
            // askById 優先 → toolById fallback の順 (同 tool_use_id が両方に居ることは無いが、
            // ask 経路を先に試すことで「ask に登録されているのに tool として処理する」誤りを防ぐ)。
            const ask = askById.get(block.tool_use_id);
            if (ask !== undefined) {
              // 充填ソースは raw line top-level の `toolUseResult.answers` を SSOT に使う。
              // tool_result.content の自然言語テキスト (`"Q"="A"` 形式) は等価情報だが、
              // 質問 / 回答テキストが `"` を含む信頼境界外データのため regex 復元が壊れる
              // (例: `"What is "foo"?"="bar"` → `[?, bar]` 誤抽出)。`answers` は Claude Code
              // が組み立てた構造化 Map なので任意 char 集合に依存しない。
              const answers = raw.toolUseResult?.answers;
              if (answers !== undefined) {
                for (const q of ask.questions) {
                  const a = answers[q.question];
                  // 「未充填」の SSOT は `q.answer === undefined` の 1 条件に閉じる。空文字
                  // answer も「未充填」と同義として undefined に倒し、consumer (回答の有無で
                  // 表示を分ける表示側) は undefined
                  // チェック 1 つだけで一貫した分岐ができる。Claude Code 仕様上空文字 answer
                  // は通常発生しないが、信頼境界外データとして来た場合の扱いを parser に
                  // 1 箇所だけ書く (consumer 側の if に `!== ""` を毎度書かない)。
                  if (typeof a === "string" && a !== "") q.answer = a;
                }
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
            // raw は JSON.parse を type assertion しただけで実行時型を保証しないため、
            // ?? だけだと number/object 等の非 string 値がそのまま紛れ込む。version/parentUuid
            // と同じ規約で typeof チェックし、string でなければ空文字に倒す。
            tool.result = {
              text: toolResultText(block.content),
              isError: block.is_error === true,
              agentId:
                typeof raw.toolUseResult?.agentId === "string" ? raw.toolUseResult.agentId : "",
              promptId: typeof raw.promptId === "string" ? raw.promptId : "",
            };
            continue;
          }
          // text / image は両 content 経路 (message.content / queued_command.prompt) で同一
          // 処理。helper に一元化済み。undefined (未知 block) は無言で落とさず skipped に計上する。
          const ev = userArrayBlockEvent(block, ts);
          if (ev === undefined) {
            skipped++;
            continue;
          }
          events.push(ev);
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
          // 思考の平文が transcript に残らず暗号化 signature だけが書かれることがある。
          // この場合 thinking は空文字 / フィールド欠落になる。
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
          events.push({ kind: "image", ts, source: imageSource(block) });
        } else {
          // 未知 block type は無言で落とさず skipped に計上する (footer 観察可能性)。
          skipped++;
        }
      }
      continue;
    }

    // queued_command (作業中に queue に積まれた会話ターン) は type:"user" に昇格せず
    // attachment.prompt にしか本文が残らないことがあるため会話イベントにする。採否と話者は
    // 上流が分類済みの commandMode と origin で決め (queuedCommandSpeaker)、本文パターンで
    // 再導出しない。user として出す prompt は本文を加工せずそのまま出す
    // (本文が <span> や <command-name> 始まりの正当な発話を切り詰めない)。
    //
    // prompt は message.content と同じ shape: テキストのみなら string、画像添付があると
    // ContentBlock[] (text + image)。array の場合は通常の user content 配列と同じく text →
    // user / image → image に分離する。string と決め打ちして配列を text に push すると base64
    // が生露出するため、shape で分岐する。
    if (raw.type === "attachment" && raw.attachment?.type === "queued_command") {
      const { commandMode, prompt } = raw.attachment;
      const resolved = commandMode === "prompt" ? queuedCommandSpeaker(raw.attachment) : HIDDEN;
      if (resolved.speaker === "hidden") {
        skipped++;
        continue;
      }
      if (resolved.speaker === "teammate") {
        const { from, text } = resolved;
        events.push({ kind: "teammate", ts, from, summary: "", text });
        continue;
      }
      if (prompt === undefined) {
        skipped++;
        continue;
      }
      if (typeof prompt === "string") {
        if (prompt === "") skipped++;
        else events.push({ kind: "user", text: prompt, ts });
        continue;
      }
      // 配列 prompt は通常の message.content と同じ text / image 処理を共有する。
      for (const block of prompt) {
        const ev = userArrayBlockEvent(block, ts);
        if (ev === undefined) {
          skipped++;
          continue;
        }
        events.push(ev);
      }
      continue;
    }

    // hook 由来 attachment はエージェントへの system 注入の永続化形なので system イベントに
    // 載せる。ランタイムでは system-reminder としてコンテキストに届く content が、JSONL 上は
    // この構造化 attachment にだけ残る (注入 user string としては書かれない)。
    // - hook_success: content は string。非空 = 注入あり (SessionStart hook の出力等)。
    //   空 = 発火記録のみ (PreToolUse の大半) で表示する中身が無いため skipped
    // - hook_additional_context: content は string[] (PreToolUse 等が注入する追加コンテキスト)。
    //   非空 string 要素を結合して載せる
    if (raw.type === "attachment") {
      const att = raw.attachment;
      const label =
        typeof att?.hookName === "string" && att.hookName !== "" ? att.hookName : "hook";
      if (att?.type === "hook_success" && typeof att.content === "string" && att.content !== "") {
        events.push({ kind: "system", label, text: att.content, ts });
        continue;
      }
      if (att?.type === "hook_additional_context" && Array.isArray(att.content)) {
        const text = att.content
          .filter((item): item is string => typeof item === "string" && item !== "")
          .join("\n");
        if (text !== "") {
          events.push({ kind: "system", label, text, ts });
          continue;
        }
      }
      // 上記以外の attachment (output_style / task_reminder / edited_text_file 等の構造化
      // メタデータ) は skipped。
      skipped++;
      continue;
    }

    // 上記以外 (system / progress / permission-mode 等) は会話 transcript には載せない。
    skipped++;
  }

  // 先頭レコードの promptId。rewind で捨てられうる分岐候補とは無関係にファイル先頭 1 件で
  // 決まる (subagent ファイルは常に spawn 元の promptId を持つ 1 行目から始まる)。raw は
  // 実行時型を保証しないため typeof で string を確認する (version/parentUuid と同じ規約)。
  const rootFirstPromptId = nodes[0]?.raw.promptId;
  const rootPromptId = typeof rootFirstPromptId === "string" ? rootFirstPromptId : "";

  return { events, models, versions, totalLines, malformed, skipped, emptyThinking, rootPromptId };
}
