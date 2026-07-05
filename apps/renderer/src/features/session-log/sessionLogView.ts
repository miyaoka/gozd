// session log ダイアログ / プレビューの view 層が使う gozd 固有の純関数群。
//
// parse モデル (TranscriptEvent / ParsedSessionLog) は @gozd/claude-session-log が SSOT。
// ここは gozd の UI 都合 (subagent タブの紐付け / 横断タイムラインの組み立て / model・時刻の
// 表示整形) に閉じた変換で、他プロジェクトに持ち出す対象ではないため package には入れない。

import type { TranscriptEvent } from "@gozd/claude-session-log";

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

/**
 * SessionLogTranscript の `select-branch` emit payload (SessionLogDialog との契約)。
 * sessionKey で発火元タブを自己記述する。親側ハンドラでタブを特定し直す形にすると
 * v-if で narrowing した値の参照が必要になり、vue-tsc 3.3.6 以降インラインハンドラは
 * 関数スコープに包まれて narrowing が届かないため、payload 側で完結させる。
 */
export interface BranchSelectPayload {
  sessionKey: string;
  branchKey: string;
  childUuid: string;
  ts: string;
}

// --- subagent 紐付け / 時刻ジャンプ (SessionLogDialog / SessionLogTranscript が使う純関数) ---

/** main の Agent / SendMessage 行を起動/宛先 subagent に結ぶリンク。 */
interface SubagentLink {
  agentId: string;
  label: string;
}

/**
 * buildSubagentLinks の 1 tool_use に対する解決結果。`resolved` (紐付く subagent が一意に
 * 決まった) と `unresolved` (Agent/SendMessage/Workflow 呼び出しではあるが一意に決められ
 * なかった) を区別する discriminated union。この tool_use が Agent/SendMessage/Workflow
 * ですらない (Bash 等、紐付け対象外) 場合は map に entry 自体を作らない。
 *
 * consumer (`SessionLogSubagentButton`) はこの3値 (resolved / unresolved / entry 無し) だけを
 * 見れば良く、「どの tool 名が紐付け対象か」という知識を持つ必要がない。tool 名リストの
 * 判定条件がこの関数内の分岐 1 箇所に閉じ、view 側との手動同期が要らなくなる。
 */
export type SubagentLinkResult = ({ status: "resolved" } & SubagentLink) | { status: "unresolved" };

/** buildSubagentLinks が参照する subagent の最小情報 (SessionTab の射影)。 */
export interface SubagentDescriptor {
  id: string; // agent_id
  label: string; // 表示ラベル
  name: string; // meta.json の name (SendMessage の to が name のことがある)
  agentType: string; // meta.json の agentType (team teammate は SendMessage の to が role 名 = agentType)
  parentToolUseId: string; // spawn した main 側 Agent tool_use id
  // この subagent の raw jsonl 先頭レコードの promptId (parsed.rootPromptId)。team teammate
  // spawn (meta.json に toolUseId を持たず、tool_result にも物理 id が乗らない) を Agent
  // tool_use に結ぶ最後の手段。promptId は「1回のプロンプト処理サイクル」単位の id で spawn
  // 単位ではないため、同一プロンプト内で複数 spawn があると複数 subagent が同じ値を共有しうる
  // (buildSubagentLinks 側で ambiguousRootPromptIds として除外する)。
  rootPromptId: string;
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
 * main の tool 呼び出し (Agent / SendMessage / Workflow) を起動/宛先 subagent に結ぶ map を作る。
 * key は main tool event の toolUseId。Agent/SendMessage/Workflow の呼び出しには、解決できても
 * できなくても必ず entry を作る (`resolved` / `unresolved`)。この3種以外の tool (Bash 等) には
 * entry を作らない。「この tool_use が紐付け対象かどうか」の唯一の判定はこの関数の分岐条件
 * (`ev.name === "Agent"` 等) であり、consumer 側で tool 名を判定し直す必要はない。
 *
 * - Agent (新規 spawn): 3段階の厳密一致のみで引く。どれも決められないときは unresolved にする
 *   (name/agentType はコーディネータ指定のラベルに過ぎず、同名 teammate を繰り返し spawn すると
 *   衝突する。実ログで確認済み: 同名 spawn 2 件の tool_result はテキストが完全一致するのに、
 *   物理的には無関係な独立 jsonl になる。ラベルへのフォールバックは誤 link を生むため使わない)。
 *     1. `tool_use.id` === subagent の `parentToolUseId` (meta.toolUseId)。通常 subagent
 *        (Agent tool を subagent_type で呼ぶ経路) の大半はこれで決まる
 *     2. `tool_result.toolUseResult.agentId` === subagent の `id`。meta.json に toolUseId が
 *        無い通常 subagent (run_in_background 系) でも tool_result 自体に spawn 先の物理 id が
 *        乗るため、これで一意に引ける (実ログで確認済み)
 *     3. `tool_result.promptId` === subagent ファイル先頭レコードの `promptId` (rootPromptId)。
 *        team teammate は 1・2 の情報を一切持たないため最後の手段になる。promptId は「1回の
 *        プロンプト処理サイクル」単位の id で spawn 単位ではないため (同一ターンで Agent を
 *        複数回呼べば tool_result 全てが同じ promptId を持つ。実ログで確認済み)、複数 subagent が
 *        同じ rootPromptId を共有する場合は一意に決められないため unresolved にする
 * - SendMessage (resume): main の `tool_use.input.to` === subagent の `id` / `name` / `agentType`
 *   (Claude Code の SendMessage は to に agent_id / agent name / role 名 のいずれも取りうる。team
 *   teammate は role 名 = agentType で宛先指定するため、name/id で引けない)。id → name → agentType
 *   の順に引き、同 name / 同 agentType が複数あると一意に決められないため unresolved にする
 *   (誤った subagent へ飛ばすより無表示が安全)。id は一意なので衝突しない。resume は新規 spawn では
 *   ないため promptId 照合は使えない (再開先の subagent ファイルに新規ルートレコードは増えない)
 * - Workflow (workflow 起動): main の Workflow tool_result テキストの `Run ID: wf_xxx` ===
 *   workflow agent 群の `workflowRunId`。1 Workflow = N agent なので先頭 agent に結ぶ
 *   (右ペインで開いた後はタブバーのグループから他 agent へ辿れる)。ラベルは `<名> (件数)`。
 *
 * toolUseId が空 (id 欠落 tool_use) の event は対象外 (entry を作らない)。
 */
export function buildSubagentLinks(
  mainEvents: TranscriptEvent[],
  subagents: SubagentDescriptor[],
): Map<string, SubagentLinkResult> {
  const links = new Map<string, SubagentLinkResult>();
  const byParentToolUse = new Map<string, SubagentDescriptor>();
  const byRootPromptId = new Map<string, SubagentDescriptor>();
  // 複数 subagent が同じ rootPromptId を共有する場合 (同一プロンプト処理サイクル内の複数 spawn)、
  // その値では一意に引けないので除外対象にする。ambiguousNames/ambiguousAgentTypes と同じ規律。
  const ambiguousRootPromptIds = new Set<string>();
  const byAgentId = new Map<string, SubagentDescriptor>();
  const byName = new Map<string, SubagentDescriptor>();
  // team teammate は SendMessage の to が役割名 (agentType) のことがあるため agentType でも引く。
  const byAgentType = new Map<string, SubagentDescriptor>();
  // 複数 subagent が同じ name / agentType を持つ場合、その値では一意に引けないので除外対象にする。
  const ambiguousNames = new Set<string>();
  const ambiguousAgentTypes = new Set<string>();
  for (const sub of subagents) {
    if (sub.parentToolUseId !== "") byParentToolUse.set(sub.parentToolUseId, sub);
    if (sub.rootPromptId !== "") {
      if (byRootPromptId.has(sub.rootPromptId)) ambiguousRootPromptIds.add(sub.rootPromptId);
      else byRootPromptId.set(sub.rootPromptId, sub);
    }
    byAgentId.set(sub.id, sub);
    if (sub.name !== "") {
      if (byName.has(sub.name)) ambiguousNames.add(sub.name);
      else byName.set(sub.name, sub);
    }
    if (sub.agentType !== "") {
      if (byAgentType.has(sub.agentType)) ambiguousAgentTypes.add(sub.agentType);
      else byAgentType.set(sub.agentType, sub);
    }
  }
  // workflowRunId → グループ。タブバー表示と同じ groupByWorkflow を SSOT に使い、
  // 「グループ先頭 agent = Workflow 行リンク先」の一貫性を保つ。
  const byWorkflowRunId = new Map(groupByWorkflow(subagents).map((g) => [g.runId, g]));

  // id → name → agentType の順にフォールバック。曖昧な name / agentType は引かない。
  // agentType は team teammate (SendMessage の to が role 名) のための最終手段。
  const resolveTo = (to: string): SubagentDescriptor | undefined => {
    const byId = byAgentId.get(to);
    if (byId !== undefined) return byId;
    if (!ambiguousNames.has(to)) {
      const byNm = byName.get(to);
      if (byNm !== undefined) return byNm;
    }
    if (ambiguousAgentTypes.has(to)) return undefined;
    return byAgentType.get(to);
  };

  // Workflow 行: result テキストの `Run ID: wf_xxx` で agent 群を引き、先頭 agent に結ぶ。
  // 結果未記録 / runId 抽出失敗 / 該当 agent ゼロ件は unresolved にする。
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

  // SubagentDescriptor (見つかれば) を SubagentLinkResult に変換する。見つからなければ unresolved。
  const toResult = (sub: SubagentDescriptor | undefined): SubagentLinkResult =>
    sub === undefined
      ? { status: "unresolved" }
      : { status: "resolved", agentId: sub.id, label: sub.label };

  for (const ev of mainEvents) {
    if (ev.kind !== "tool" || ev.toolUseId === "") continue;
    if (ev.name === "Agent") {
      // 3段階の厳密一致 (parentToolUseId → tool_result.agentId → rootPromptId、後者は
      // ambiguousRootPromptIds を経由)。name/agentType はラベルに過ぎず同名 spawn の
      // 繰り返しで衝突するため、フォールバックには使わない (関数ヘッダのコメント参照)。
      let sub = byParentToolUse.get(ev.toolUseId);
      if (sub === undefined && ev.result !== undefined && ev.result.agentId !== "") {
        sub = byAgentId.get(ev.result.agentId);
      }
      // rootPromptId フォールバックは、物理 id (agentId) を一切持たない team teammate 限定の
      // 最終手段。agentId を持つ通常 subagent がまだ候補一覧に現れていない (live refresh の
      // タイミング差等) だけのケースでこの分岐に落ちると、同じ promptId を共有する無関係な
      // 別 subagent に誤ってリンクしてしまうため、agentId が空のときだけ試す。
      if (
        sub === undefined &&
        ev.result !== undefined &&
        ev.result.agentId === "" &&
        ev.result.promptId !== "" &&
        !ambiguousRootPromptIds.has(ev.result.promptId)
      ) {
        sub = byRootPromptId.get(ev.result.promptId);
      }
      links.set(ev.toolUseId, toResult(sub));
    } else if (ev.name === "SendMessage") {
      const to = ev.input.to;
      links.set(ev.toolUseId, toResult(typeof to === "string" ? resolveTo(to) : undefined));
    } else if (ev.name === "Workflow") {
      const link = resolveWorkflow(ev.result?.text);
      links.set(
        ev.toolUseId,
        link === undefined ? { status: "unresolved" } : { status: "resolved", ...link },
      );
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
