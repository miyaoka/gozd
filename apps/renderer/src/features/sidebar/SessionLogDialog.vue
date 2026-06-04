<doc lang="md">
task ⋮ メニューの「Show session log」から開くセッションログ表示 dialog。
`useSessionLogViewer` の context (`sessionId` + `title`) が定義されたら開く。

## レイアウト

ヘッダ下に横断タイムライン (`SessionLogTimeline`) を全幅で出し、その下に Main セッションを
左ペインに常時表示し、subagent があれば選択中の 1 つを右ペインに横並びで同時表示する
(2 ペイン)。各ペインの中身 (チャット本文 + footer) は `SessionLogTranscript` が担う。

タイムラインは main + 各 subagent の生存期間 (`sessionTimeRange` が events の min/max ts から
算出) を 1 本の共通時間軸に並べ、Chrome DevTools 風にスレッドを統一表示する。これが旧来の
「ペインごとの縦目次」と「subagent タブバー」を兼ねる: バー / ラベルをクリックすると該当
ペインを開いてその時刻位置へ seek し、main ペインのスクロール位置は全トラックを貫く playhead
で示す。トラック順は main (anchor) を先頭固定し、subagent は単位 (plain subagent 1 件 /
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
  buildSubagentLinks,
  groupByWorkflow,
  parseSessionLog,
  sessionLogDirOf,
  sessionTimeRange,
  subagentTabLabel,
  type ParsedSessionLog,
  type SubagentLink,
} from "./sessionLog";
import SessionLogTimeline, { type TimelineTrack } from "./SessionLogTimeline.vue";
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
  parsed: ParsedSessionLog;
}
const sessions = ref<SessionTab[]>([]);
// entries[0] が main。subagents はそれ以降。
const mainSession = computed<SessionTab | undefined>(() =>
  sessions.value.find((s) => s.kind === "main"),
);
const subagents = computed<SessionTab[]>(() => sessions.value.filter((s) => s.kind !== "main"));
// Task ツール subagent (workflowRunId 空)。横断タイムラインで main の次に並べる。
const plainSubagents = computed<SessionTab[]>(() =>
  subagents.value.filter((s) => s.workflowRunId === ""),
);
// workflow agent は workflowRunId でグループ化する (出現順保持)。タイムラインのトラック順
// (グループ見出し名 + 並び) と先頭 agent の一貫性は sessionLog の純関数 groupByWorkflow に
// 委ねる (buildSubagentLinks と SSOT 共有)。
const workflowGroups = computed(() => groupByWorkflow(subagents.value));

// 右ペインに出す subagent。subagent が 1 つでもあれば先頭を初期選択する。
const activeSubId = ref<string | undefined>(undefined);
const activeSub = computed<SessionTab | undefined>(() =>
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
function toTrack(
  s: SessionTab,
  opts: { isMain?: boolean; iconKind?: TimelineTrack["iconKind"]; indent?: boolean },
): TimelineTrack {
  const range = sessionTimeRange(s.parsed.events);
  return {
    id: s.id,
    label: s.label,
    isMain: opts.isMain ?? false,
    isHeader: false,
    indent: opts.indent ?? false,
    iconKind: opts.iconKind,
    startMs: range?.startMs,
    endMs: range?.endMs,
  };
}

// 開始時刻の比較。ts 不在 (undefined) は時系列に置けないため末尾へ寄せる。
function compareMaybeMs(a: number | undefined, b: number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

// 並べ替えの 1 単位。plain subagent は単独 (tracks 1 件)、workflow グループは [見出し + agent群]。
// earliest は単位の最古開始時刻で、単位同士を古い順に並べるキー。
interface TimelineUnit {
  earliest: number | undefined;
  tracks: TimelineTrack[];
}

// 横断タイムラインのトラック。main を anchor として先頭固定し、subagent は単位ごとに古い順。
// workflow は見出し行 + 配下 agent (内部も古い順) を 1 単位として contiguous に保つ。
const timelineTracks = computed<TimelineTrack[]>(() => {
  const tracks: TimelineTrack[] = [];
  const main = mainSession.value;
  if (main !== undefined) tracks.push(toTrack(main, { isMain: true }));

  const units: TimelineUnit[] = [];
  // plain subagent: 1 トラック = 1 単位。
  for (const s of plainSubagents.value) {
    const track = toTrack(s, { iconKind: "subagent" });
    units.push({ earliest: track.startMs, tracks: [track] });
  }
  // workflow グループ: 見出し行 + 配下 agent (古い順) を 1 単位にまとめる。
  for (const group of workflowGroups.value) {
    const agentTracks = group.agents
      .map((s) => toTrack(s, { indent: true }))
      .sort((a, b) => compareMaybeMs(a.startMs, b.startMs));
    const starts = agentTracks.map((t) => t.startMs).filter((m): m is number => m !== undefined);
    const header: TimelineTrack = {
      id: group.runId,
      label: group.name,
      isMain: false,
      isHeader: true,
      indent: false,
      iconKind: "workflow",
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
});

// 初回 / フォールバックで右ペインに開く subagent。タイムライン最下段 (= 最新) の subagent に
// 揃える: timelineTracks の末尾から最初に見つかる session 行 (見出し / main 以外)。表示順の
// SSOT を timelineTracks に一本化し、「一番下に並ぶ subagent が最初に開く」を保証する。
const newestSubagentId = computed<string | undefined>(() => {
  const list = timelineTracks.value;
  for (let i = list.length - 1; i >= 0; i--) {
    const track = list[i];
    if (!track.isHeader && !track.isMain) return track.id;
  }
  return undefined;
});

// 全トラックを覆う共通時間軸 (有効 ts を持つトラックの min start / max end)。
const timelineAxis = computed<{ startMs: number; endMs: number } | undefined>(() => {
  let startMs: number | undefined;
  let endMs: number | undefined;
  for (const t of timelineTracks.value) {
    if (t.startMs === undefined || t.endMs === undefined) continue;
    if (startMs === undefined || t.startMs < startMs) startMs = t.startMs;
    if (endMs === undefined || t.endMs > endMs) endMs = t.endMs;
  }
  if (startMs === undefined || endMs === undefined) return undefined;
  return { startMs, endMs };
});

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
    parsed: parseSessionLog(entry.content),
  };
}

async function load(sessionId: string) {
  const token = ++loadToken;
  loading.value = true;
  errorMessage.value = undefined;
  notFound.value = false;
  sessions.value = [];
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
    class="m-auto bg-transparent p-0 backdrop:bg-black/50"
    @click="onDialogClick"
    @close="close"
  >
    <div
      v-if="context"
      class="flex h-[85vh] w-[1320px] max-w-[92vw] flex-col rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 shadow-xl"
    >
      <!-- ヘッダ -->
      <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div class="min-w-0">
          <h2 class="truncate text-sm font-semibold" :title="context.title">
            {{ context.title }}
          </h2>
          <p class="truncate text-[10px] text-zinc-500" :title="context.sessionId">
            {{ context.sessionId }}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          class="grid size-7 shrink-0 place-items-center rounded-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
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
        <p v-if="loading" class="px-4 py-3 text-sm text-zinc-400">Loading session log…</p>
        <p v-else-if="errorMessage" class="px-4 py-3 text-sm text-red-400">
          Failed to read session log: {{ errorMessage }}
        </p>
        <p v-else-if="notFound" class="px-4 py-3 text-sm text-zinc-400">
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
          class="min-w-0 flex-1 border-l border-zinc-800"
        />
      </div>
    </div>
  </dialog>
</template>
