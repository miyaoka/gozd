<doc lang="md">
task ⋮ メニューの「Show session log」から開くセッションログ表示 dialog。
`useSessionLogViewer` の context (`sessionId` + `title`) が定義されたら開く。

## レイアウト

ヘッダ下に横断タイムライン (`SessionLogTimeline`) を全幅で出し、その下に Main セッションを
左ペインに常時表示し、subagent があれば選択中の 1 つを右ペインに横並びで同時表示する
(2 ペイン)。各ペインの中身 (チャット本文 + footer) は `SessionLogTranscript` が担う。

タイムラインは main + 各 subagent の生存期間を 1 本の共通時間軸に並べ、Chrome DevTools 風に
スレッドを統一表示する。タイムラインがスレッド選択と時刻ナビゲーションを担う: バー / ラベルを
クリックすると該当ペインを開いてその時刻位置へ seek し、main ペインのスクロール位置は全トラックを
貫く playhead で示す。トラック順は main (anchor) を先頭固定し、subagent は単位 (plain subagent 1 件 /
workflow グループ 1 塊) ごとに最古開始時刻で古い順に並べる。workflow は見出し行 + 配下 agent
(内部も古い順) を 1 単位として contiguous に保つ。

subagent が居て軸を引けるときだけタイムラインを出す。subagent が無ければ Main のみを全幅
表示し、タイムラインも右ペインも出さない (1 本バーは情報量が無いため)。

3 階層 (main → workflow → agent) を 2 ペインに畳むため、main の `Workflow` 行リンクは「グループ
先頭 agent を開く」入口に徹し、残りはタイムラインの各トラックから辿らせる。

## 動作

- open 時に `rpcClaudeSessionLog` で native から main + subagents (Task + Workflow) の生 JSONL を
  取得し、各 entry を `parseSessionLog` で transcript 化して保持する。`entries[0]` が main、
  残りが subagents。subagent タブを選ぶと右ペインの transcript が切り替わる
- 取得失敗 / 未発見 / 空ログはそれぞれ明示メッセージを出す (fallback で握り潰さない)
- rewind があるセッションはデフォルトで最新枝だけを表示する。分岐点に出る branch セレクタを
  クリックすると `branchSelections` (tabId → branchKey → childUuid) を更新し、`parsedSessions`
  computed がそのバージョンへ再 parse する。選択はライブ refresh を跨いで保持し、別セッション
  load でクリアする

## ライブ更新

open 中はログの親 dir (`~/.claude/projects/<encoded>/`) を `rpcFsWatch` で監視し、`fsChange`
push を受けたら debounce して再読込する。再読込は `loading` を立てず `sessions` を差し替える
だけのサイレント更新で、`SessionLogTranscript` の remount とスクロール状態リセットを避ける。
close / unmount で `rpcFsUnwatch` する。worktree 外のログなので filer の app-scope watch には
乗らず、dialog 自身が watch ライフサイクルを所有する。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed, onUnmounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import type { FsChangePayload } from "../filer";
import { rpcClaudeSessionLog, rpcFsUnwatch, rpcFsWatch } from "./rpc";
import {
  type BranchSelection,
  buildSubagentLinks,
  buildTimelineTracks,
  groupByWorkflow,
  newestSubagentTrackId,
  parseSessionLog,
  sessionLogDirOf,
  subagentTabLabel,
  timelineAxisRange,
  type ParsedSessionLog,
  type SubagentLink,
  type TimelineSession,
  type TimelineTrack,
} from "./sessionLog";
import SessionLogTimeline from "./SessionLogTimeline.vue";
import SessionLogTranscript from "./SessionLogTranscript.vue";
import { useSessionLogViewer } from "./useSessionLogViewer";

const { context, close } = useSessionLogViewer();
const notify = useNotificationStore();

const dialogRef = ref<HTMLDialogElement | undefined>(undefined);
const loading = ref(false);
const errorMessage = ref<string | undefined>(undefined);
const notFound = ref(false);

// main + subagents を 1 タブ = 1 セッションとして保持する。main は左ペインに常時表示し、
// subagent は activeSubId で選んだ 1 つを右ペインに出す。
interface SessionTab {
  kind: string; // "main" | "subagent"
  id: string; // main は session_id、subagent は agent_id
  label: string; // タブ表示名
  // subagent を spawn した main の Agent tool_use id (meta.json の toolUseId)。main は空文字。
  parentToolUseId: string;
  // subagent の名前 (meta.json の name)。SendMessage の to が name のとき紐付けに使う。main は空。
  name: string;
  // workflow agent が属する workflow run の id。非 workflow subagent / main は空文字。
  workflowRunId: string;
  // workflow の表示名 (グループ見出し)。非 workflow subagent / main は空文字。
  workflowName: string;
  // 生 JSONL。parse は branchSelections 依存の computed (parsedSessions) で行う。
  content: string;
}
// parse 済みタブ。content + そのタブの branch 選択から parsed を導出した派生型。
interface ParsedSessionTab extends SessionTab {
  parsed: ParsedSessionLog;
}
const sessions = ref<SessionTab[]>([]);

// rewind 分岐の選択状態。tabId (session_id / agent_id) → そのタブの BranchSelection
// (branchKey → 選択 childUuid)。未選択の分岐点は parseSessionLog 側が最新枝にフォールバックする。
// ライブ refresh を跨いで保持し (キーが安定なら選択が残る)、別セッション load でクリアする。
const branchSelections = ref<Map<string, BranchSelection>>(new Map());

// content + branch 選択から各タブを parse する。selection 変更で該当バージョンへ再構築される。
const parsedSessions = computed<ParsedSessionTab[]>(() =>
  sessions.value.map((s) => ({
    ...s,
    parsed: parseSessionLog(s.content, branchSelections.value.get(s.id)),
  })),
);

// 分岐セレクタのクリック: そのタブの branchKey を指定 childUuid に切り替える (枝の差し替え)。
// reactivity のため Map は複製して差し替える。併せて該当ペインを選択枝の先頭 (ts) へ寄せる:
// 枝切替は parsed を差し替えるため Transcript の parsed watch が走るが、scrollTarget を立てて
// おくとボトム追従を抑止して分岐点位置を保てる。scrollTarget は scrollNonce で必ず変化させ、
// 同 ts への連続切替でも子の watch を発火させる。
function selectBranch(tabId: string, branchKey: string, childUuid: string, ts: string) {
  const next = new Map(branchSelections.value);
  const inner = new Map(next.get(tabId) ?? []);
  inner.set(branchKey, childUuid);
  next.set(tabId, inner);
  branchSelections.value = next;

  const target = { ts, nonce: ++scrollNonce };
  if (tabId === mainSession.value?.id) mainScrollTarget.value = target;
  else subScrollTarget.value = target;
}

// entries[0] が main。subagents はそれ以降。
const mainSession = computed<ParsedSessionTab | undefined>(() =>
  parsedSessions.value.find((s) => s.kind === "main"),
);
const subagents = computed<ParsedSessionTab[]>(() =>
  parsedSessions.value.filter((s) => s.kind !== "main"),
);
// Task ツール subagent (workflowRunId 空)。横断タイムラインで main の次に並べる。
const plainSubagents = computed<ParsedSessionTab[]>(() =>
  subagents.value.filter((s) => s.workflowRunId === ""),
);
// workflow agent は workflowRunId でグループ化する (出現順保持)。タイムラインのトラック順
// (グループ見出し名 + 並び) と先頭 agent の一貫性は sessionLog の純関数 groupByWorkflow に
// 委ねる (buildSubagentLinks と SSOT 共有)。
const workflowGroups = computed(() => groupByWorkflow(subagents.value));

// 右ペインに出す subagent。subagent が 1 つでもあれば先頭を初期選択する。
const activeSubId = ref<string | undefined>(undefined);
const activeSub = computed<ParsedSessionTab | undefined>(() =>
  subagents.value.find((s) => s.id === activeSubId.value),
);

// main の Agent / SendMessage 呼び出しを subagent に結ぶ map (key=main tool event の toolUseId)。
// 畳み込みロジックは sessionLog の純関数 buildSubagentLinks に委ねる (テスト可能性 + SSOT)。
const mainSubagentLinks = computed<Map<string, SubagentLink>>(() => {
  const main = mainSession.value;
  if (main === undefined) return new Map<string, SubagentLink>();
  return buildSubagentLinks(
    main.parsed.events,
    subagents.value.map((s) => ({
      id: s.id,
      label: s.label,
      name: s.name,
      parentToolUseId: s.parentToolUseId,
      workflowRunId: s.workflowRunId,
      workflowName: s.workflowName,
    })),
  );
});

// 時刻ジャンプ target。ペインごとに独立して持つ (main / subagent を別々に seek できる)。
// nonce は同一 ts の再クリックでも子の watch を発火させるための単調増加値。
const subScrollTarget = ref<{ ts: string; nonce: number } | undefined>(undefined);
const mainScrollTarget = ref<{ ts: string; nonce: number } | undefined>(undefined);
let scrollNonce = 0;

// main のボタンクリック: 対応 subagent を右ペインに出し、その ts へ同期スクロールする。
function openSubagent(payload: { agentId: string; ts: string }) {
  activeSubId.value = payload.agentId;
  subScrollTarget.value = { ts: payload.ts, nonce: ++scrollNonce };
}

// main ペインの現在スクロール位置 (topmost 可視イベントの ts)。横断タイムラインの playhead に使う。
// main 側はユーザー操作スクロール時のみ current-ts を発火する (programmatic は抑制済み)。
const mainCurrentTs = ref<string>("");

// main を手スクロールしたら、その時刻を playhead に反映しつつ、選択中 subagent もその時刻の
// 最近傍へ同期させる (main を master にした一方向同期。sub への seek は programmatic なので
// フィードバックしない)。
function onMainCurrentTs(ts: string) {
  mainCurrentTs.value = ts;
  subScrollTarget.value = { ts, nonce: ++scrollNonce };
}
const playheadMs = computed<number | undefined>(() => {
  if (mainCurrentTs.value === "") return undefined;
  const ms = Date.parse(mainCurrentTs.value);
  return Number.isNaN(ms) ? undefined : ms;
});

// 1 セッション → 1 session トラック。生存期間は sessionTimeRange (純関数) が events の
// min/max ts から算出。
function toTimelineSession(s: ParsedSessionTab): TimelineSession {
  return { id: s.id, label: s.label, events: s.parsed.events, models: s.parsed.models };
}

// 横断タイムラインのトラック。並べ替え (main 先頭固定 / subagent 古い順 / workflow contiguous) と
// 軸算出 / 最下段判定は sessionLog の純関数に委ねる (テスト可能性 + SSOT)。
const timelineTracks = computed<TimelineTrack[]>(() =>
  buildTimelineTracks({
    main: mainSession.value === undefined ? undefined : toTimelineSession(mainSession.value),
    plainSubagents: plainSubagents.value.map(toTimelineSession),
    workflowGroups: workflowGroups.value.map((group) => ({
      name: group.name,
      runId: group.runId,
      agents: group.agents.map(toTimelineSession),
    })),
  }),
);

// 初回 / フォールバックで右ペインに開く subagent。タイムライン最下段 (= 最新) に揃える。
const newestSubagentId = computed<string | undefined>(() =>
  newestSubagentTrackId(timelineTracks.value),
);

// 全トラックを覆う共通時間軸 (有効 ts を持つトラックの min start / max end)。
const timelineAxis = computed(() => timelineAxisRange(timelineTracks.value));

// タイムラインは subagent が居て、かつ軸を引ける (有効 ts がある) ときだけ出す。
// main 単独のログはチャットを上から読むだけで足り、1 本バーは情報量が無いため出さない。
const showTimeline = computed<boolean>(
  () => subagents.value.length > 0 && timelineAxis.value !== undefined,
);

// タイムラインのバー / ラベルクリック: クリック時刻位置へ seek する。main はそのまま
// main ペインを、それ以外は右ペインに該当 subagent を出してジャンプする。
function onTimelineSeek(payload: { id: string; ms: number }) {
  const ts = new Date(payload.ms).toISOString();
  const nonce = ++scrollNonce;
  if (payload.id === mainSession.value?.id) {
    mainScrollTarget.value = { ts, nonce };
    return;
  }
  activeSubId.value = payload.id;
  subScrollTarget.value = { ts, nonce };
}

// 軸ヘッダの scrub: main と選択中 subagent の両ペインを同じ ts の最近傍イベントへ寄せる。
// activeSubId は変えない (今見ている subagent をその時刻に同期するだけ)。
function onTimelineScrub(ms: number) {
  const ts = new Date(ms).toISOString();
  const nonce = ++scrollNonce;
  mainScrollTarget.value = { ts, nonce };
  subScrollTarget.value = { ts, nonce };
}

// load の世代カウンタ。await を跨いだ stale な完了結果が新しいセッション表示を
// 上書きするのを防ぐ。新規 load 開始 / refresh / dialog close のたびに increment し、
// await 後に自分の token が最新でなければ state を触らず捨てる。
let loadToken = 0;

// 1 entry → 1 SessionTab。初回 load とライブ refresh の両方で使う (SSOT)。
function toSessionTab(entry: {
  kind: string;
  id: string;
  label: string;
  agentType: string;
  parentToolUseId: string;
  name: string;
  workflowRunId: string;
  workflowName: string;
  phaseTitle: string;
  content: string;
}): SessionTab {
  return {
    kind: entry.kind,
    id: entry.id,
    label: entry.kind === "main" ? "Main" : subagentTabLabel(entry),
    parentToolUseId: entry.parentToolUseId,
    name: entry.name,
    workflowRunId: entry.workflowRunId,
    workflowName: entry.workflowName,
    content: entry.content,
  };
}

async function load(sessionId: string) {
  const token = ++loadToken;
  loading.value = true;
  errorMessage.value = undefined;
  notFound.value = false;
  sessions.value = [];
  // 別セッションの分岐選択は引き継がない (tabId が変わるため意味を持たない)。
  branchSelections.value = new Map();
  activeSubId.value = undefined;
  subScrollTarget.value = undefined;
  mainScrollTarget.value = undefined;
  mainCurrentTs.value = "";

  const result = await tryCatch(rpcClaudeSessionLog({ sessionId }));
  // 別 load / close に追い越されていたら、この結果は stale なので破棄する。
  if (token !== loadToken) return;
  loading.value = false;
  if (!result.ok) {
    errorMessage.value = result.error.message;
    notify.error("Failed to read session log", result.error);
    return;
  }
  if (!result.value.found || result.value.entries.length === 0) {
    notFound.value = true;
    return;
  }

  // entries[0] が main、残りが subagents。各 entry を 1 タブに parse する。
  sessions.value = result.value.entries.map(toSessionTab);
  // subagent があればタイムライン最下段 (= 最新) を右ペインに初期表示する。
  activeSubId.value = newestSubagentId.value;
  // ログファイルの親 dir を watch してライブ更新する。
  void setWatchDir(sessionLogDirOf(result.value.entries));
}

// --- ライブ更新 (ファイル監視 → サイレント refresh) ---
//
// Claude が書き込む jsonl は worktree の外 (~/.claude/projects/<encoded>/) にあり filer の
// app-scope watch には乗らない。dialog が開いている間だけログの親 dir を watch し、fsChange を
// 受けたら再読込する。再読込は loading フラグを立てず sessions を差し替えるだけにして、
// transcript の remount とスクロール状態のリセットを避ける (:key は同一 sessionId で安定)。
// watch dir の解決 (sessionLogDirOf) は sessionLog.ts の純関数に委ね、境界をテストする。

// 現在 native 側で watch 中のログ dir。open 中の 1 セッション分のみ保持する。
let currentWatchDir: string | undefined;

// watch 対象 dir を差し替える。前の dir を unwatch し、新しい dir を watch する。
// next === undefined は close 経路で、現在の watch を解除するだけ。
async function setWatchDir(next: string | undefined) {
  if (next === currentWatchDir) return;
  const prev = currentWatchDir;
  currentWatchDir = next;
  if (prev !== undefined) {
    const r = await tryCatch(rpcFsUnwatch({ dir: prev }));
    if (!r.ok) notify.error("Failed to stop watching session log", r.error);
  }
  if (next !== undefined) {
    const r = await tryCatch(rpcFsWatch({ dir: next }));
    if (!r.ok) notify.error("Failed to watch session log", r.error);
  }
}

// fsChange を debounce して 1 回の refresh に畳む。jsonl は 1 応答中に多数の追記が走るため、
// 連続 event を coalesce してリロード回数を抑える。
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function cancelRefresh() {
  if (refreshTimer === undefined) return;
  clearTimeout(refreshTimer);
  refreshTimer = undefined;
}
function scheduleRefresh() {
  cancelRefresh();
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refresh();
  }, 250);
}

// 既存表示を保ったまま jsonl を読み直し parsed を差し替える。読み取り失敗 / 消失時は
// 既存表示を維持する (書き込み途中の一過性エラーで画面を消さない)。
async function refresh() {
  const ctx = context.value;
  if (ctx === undefined) return;
  const token = ++loadToken;
  const result = await tryCatch(rpcClaudeSessionLog({ sessionId: ctx.sessionId }));
  if (token !== loadToken) return;
  if (!result.ok) {
    notify.error("Failed to refresh session log", result.error);
    return;
  }
  if (!result.value.found || result.value.entries.length === 0) return;
  sessions.value = result.value.entries.map(toSessionTab);
  // 選択中の subagent が消えていたら最新 (最下段) へ寄せる (computed は sessions.value から
  // 再評価される)。生存している間はユーザーの選択を保ち、ライブ更新で勝手に切り替えない。
  if (activeSubId.value !== undefined && !subagents.value.some((s) => s.id === activeSubId.value)) {
    activeSubId.value = newestSubagentId.value;
  }
}

// fsChange の購読は component scope で 1 度だけ張る。dialog が閉じている間は no-op。
const stopFsChange = onMessage<FsChangePayload>("fsChange", ({ dir, relDir }) => {
  if (context.value === undefined || dir !== currentWatchDir) return;
  // 親 dir には他セッションの jsonl も同居する。当該セッションの main (relDir === "") か
  // subagents (relDir が "<sessionId>/...") の変更だけ拾い、無関係な再読込を減らす。
  const sid = context.value.sessionId;
  if (relDir !== "" && !relDir.startsWith(sid)) return;
  scheduleRefresh();
});

onUnmounted(() => {
  stopFsChange();
  cancelRefresh();
  void setWatchDir(undefined);
});

// close 経路を片方向に統一する。ユーザー操作 (X / backdrop / ESC) はすべて native
// `dialog.close()` を起点にし、それが発火する `@close` だけが context を undefined にする
// 単一の state 同期点。context が SSOT で、この watch が open/close を駆動する。watch 側の
// `dialog.close()` は外部から `close()` だけ呼ばれた (native close を伴わない) ケースの
// 保険で、既に閉じていれば呼ばない。
watch(context, (next) => {
  const dialog = dialogRef.value;
  if (next === undefined) {
    // 進行中の load を無効化し、close 後に stale 結果が state を書き戻すのを防ぐ。
    loadToken++;
    // ライブ更新の後始末を unmount と対称に揃える: 保留中の refresh timer を消し、
    // watch を解除する (open 中のセッション分のみ保持しているため)。
    cancelRefresh();
    void setWatchDir(undefined);
    if (dialog?.open === true) dialog.close();
    return;
  }
  // 既に open な <dialog> への showModal は InvalidStateError を投げるためガードする。
  if (dialog !== undefined && !dialog.open) dialog.showModal();
  void load(next.sessionId);
});

// X / backdrop は native close を起こすだけ。state 同期は @close → close() に集約する。
function requestClose() {
  dialogRef.value?.close();
}

function onDialogClick(event: MouseEvent) {
  if (event.target === dialogRef.value) requestClose();
}
</script>

<template>
  <dialog
    ref="dialogRef"
    class="m-auto bg-transparent p-0 backdrop:bg-overlay"
    @click="onDialogClick"
    @close="close"
  >
    <div
      v-if="context"
      class="flex h-[85vh] w-[1320px] max-w-[92vw] flex-col rounded-lg border border-border bg-background text-foreground shadow-xl"
    >
      <!-- ヘッダ -->
      <div class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <div class="min-w-0">
          <h2 class="truncate text-sm font-semibold" :title="context.title">
            {{ context.title }}
          </h2>
          <p class="truncate text-[10px] text-foreground-low" :title="context.sessionId">
            {{ context.sessionId }}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          class="grid size-7 shrink-0 place-items-center rounded-sm text-foreground-low hover:bg-panel hover:text-foreground"
          @click="requestClose"
        >
          <span class="icon-[lucide--x] text-base" />
        </button>
      </div>

      <!-- 横断タイムライン: main + 各 subagent の生存期間を共通時間軸に並べる。subagent が
           居て軸を引けるときだけ出す。バー / ラベルクリックで該当ペインへ seek する。 -->
      <SessionLogTimeline
        v-if="showTimeline && timelineAxis"
        :tracks="timelineTracks"
        :axis-start-ms="timelineAxis.startMs"
        :axis-end-ms="timelineAxis.endMs"
        :active-sub-id="activeSubId"
        :playhead-ms="playheadMs"
        @seek="onTimelineSeek"
        @scrub="onTimelineScrub"
      />

      <!-- 本文: 状態メッセージ or [左 Main + 右 subagent] の 2 ペイン -->
      <div class="flex min-h-0 flex-1">
        <!-- 状態メッセージ (loading / error / notFound) は全幅 -->
        <p v-if="loading" class="px-4 py-3 text-sm text-foreground-low">Loading session log…</p>
        <p v-else-if="errorMessage" class="px-4 py-3 text-sm text-destructive-text">
          Failed to read session log: {{ errorMessage }}
        </p>
        <p v-else-if="notFound" class="px-4 py-3 text-sm text-foreground-low">
          No log file found for this session (not started yet, or cleaned up).
        </p>

        <!-- 左: Main セッション (常時表示)。subagent が無ければ単独で全幅。
             Agent / SendMessage 行の subagent ボタンから右ペインを開く。 -->
        <SessionLogTranscript
          v-else-if="mainSession"
          :key="mainSession.id"
          :parsed="mainSession.parsed"
          :title="mainSession.label"
          :subtitle="mainSession.id"
          :session-key="mainSession.id"
          :subagent-links="mainSubagentLinks"
          :scroll-to="mainScrollTarget"
          class="min-w-0 flex-1"
          @open-subagent="openSubagent"
          @current-ts="onMainCurrentTs"
          @select-branch="
            selectBranch(mainSession.id, $event.branchKey, $event.childUuid, $event.ts)
          "
        />

        <!-- 右: 選択中の subagent (あれば横並び)。scrollTo で呼び出し時刻へ同期する。 -->
        <SessionLogTranscript
          v-if="!loading && !errorMessage && !notFound && activeSub"
          :key="activeSub.id"
          :parsed="activeSub.parsed"
          :title="activeSub.label"
          :subtitle="activeSub.id"
          :session-key="activeSub.id"
          :scroll-to="subScrollTarget"
          class="min-w-0 flex-1 border-l border-border-subtle"
          @select-branch="selectBranch(activeSub.id, $event.branchKey, $event.childUuid, $event.ts)"
        />
      </div>
    </div>
  </dialog>
</template>
