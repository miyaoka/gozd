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

- load / debounce refresh / rpcFsWatch / rpcFsUnwatch は `useSessionLogLive(sessionId)` に
  委譲する。dialog は `context.sessionId` を入力に composable から `sessions` / `loading` /
  `errorMessage` / `notFound` を受け、表示・分岐選択・スクロール同期に専念する
- 各 entry を `parseSessionLog` で transcript 化する (`entries[0]` が main、残りが subagents)。
  subagent タブを選ぶと右ペインの transcript が切り替わる
- 取得失敗 / 未発見 / 空ログはそれぞれ明示メッセージを出す (fallback で握り潰さない)
- rewind があるセッションはデフォルトで最新枝だけを表示する。分岐点に出る branch セレクタを
  クリックすると `branchSelections` (tabId → branchKey → childUuid) を更新し、`parsedSessions`
  computed がそのバージョンへ再 parse する。選択はライブ refresh を跨いで保持し、別セッション
  load でクリアする

## ライブ更新

`useSessionLogLive` が `context.sessionId` / `context.worktreePath` の変化を watch して、
specific projectDir (`~/.claude/projects/<encoded>/`) を `rpcFsWatch` で監視し、`fsChange`
push を受けたら debounce して再読込する。worktreePath は dialog を開いた task の
`worktreeDir` 由来で、native 側が cwd encoding (`/` `.` → `-`) で projectDir を確定し、
不在なら idempotent mkdir で作る。再読込は `loading` を立てず `sessions` を差し替える
だけのサイレント更新で、`SessionLogTranscript` の remount とスクロール状態リセットを避ける。
context が undefined になった / dialog がアンマウントされた時点で composable が
`rpcFsUnwatch` を発射する。worktree 外のログなので filer の app-scope watch には乗らず、
composable が watch ライフサイクルを所有する。
</doc>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  type BranchSelection,
  buildSubagentLinks,
  buildTimelineTracks,
  groupByWorkflow,
  newestSubagentTrackId,
  parseSessionLog,
  timelineAxisRange,
  type ParsedSessionLog,
  type SubagentLink,
  type TimelineSession,
  type TimelineTrack,
} from "./sessionLog";
import SessionLogTimeline from "./SessionLogTimeline.vue";
import SessionLogTranscript from "./SessionLogTranscript.vue";
import { useSessionLogLive, type SessionTab } from "./useSessionLogLive";
import { useSessionLogViewer } from "./useSessionLogViewer";

const { context, close } = useSessionLogViewer();

const dialogRef = ref<HTMLDialogElement | undefined>(undefined);

// dialog の `context.sessionId` を入力とし、生 SessionTab[] とロード状態を
// `useSessionLogLive` に出させる。load / debounce refresh / rpcFsWatch / rpcFsUnwatch
// のライフサイクル全部は composable 側に閉じ、dialog は表示・分岐選択・スクロール同期に
// 専念する。dialog 自身は rpcClaudeSessionLog / rpcFsWatch / rpcFsUnwatch を直接触らない。
const sessionId = computed(() => context.value?.sessionId);
const worktreePath = computed(() => context.value?.worktreePath);
const { sessions, loading, errorMessage, notFound } = useSessionLogLive(sessionId, worktreePath);

// parse 済みタブ。content + そのタブの branch 選択から parsed を導出した派生型。
interface ParsedSessionTab extends SessionTab {
  parsed: ParsedSessionLog;
}

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

// close 経路を片方向に統一する。ユーザー操作 (X / backdrop / ESC) はすべて native
// `dialog.close()` を起点にし、それが発火する `@close` だけが context を undefined にする
// 単一の state 同期点。context が SSOT で、この watch が open/close を駆動する。
// load / fsWatch は useSessionLogLive が sessionId 変化に追随して自分で回す。
watch(context, (next) => {
  const dialog = dialogRef.value;
  if (next === undefined) {
    if (dialog?.open === true) dialog.close();
    return;
  }
  // 既に open な <dialog> への showModal は InvalidStateError を投げるためガードする。
  if (dialog !== undefined && !dialog.open) dialog.showModal();
});

// 別セッションに切り替わったら dialog 固有 state (分岐選択 / スクロール位置 / 選択
// subagent) をリセットする。useSessionLogLive 側でも sessions は空になるが、こちらは
// dialog 内部の派生状態なので明示的にクリアする。
watch(
  () => context.value?.sessionId,
  () => {
    branchSelections.value = new Map();
    activeSubId.value = undefined;
    subScrollTarget.value = undefined;
    mainScrollTarget.value = undefined;
    mainCurrentTs.value = "";
  },
);

// sessions が差し替わるたびに activeSubId の存続を確認する。初回 load 直後 (undefined →
// 最新枝) と、ライブ refresh で選択中 subagent が消えたとき (新たな最新枝) の 2 経路を
// 同じ規律で処理する。生存している間はユーザーの選択を保ち、勝手に切り替えない。
watch(sessions, () => {
  if (activeSubId.value === undefined) {
    activeSubId.value = newestSubagentId.value;
    return;
  }
  if (!subagents.value.some((s) => s.id === activeSubId.value)) {
    activeSubId.value = newestSubagentId.value;
  }
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
