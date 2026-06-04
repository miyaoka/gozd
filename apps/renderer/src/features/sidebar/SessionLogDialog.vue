<doc lang="md">
task ⋮ メニューの「Show session log」から開くセッションログ表示 dialog。
`useSessionLogViewer` の context (`sessionId` + `title`) が定義されたら開く。

## レイアウト

Main セッションを左ペインに常時表示し、subagent があれば選択中の 1 つを右ペインに
横並びで同時表示する (2 ペイン)。各ペインの中身 (目次 + チャット本文 + footer) は
`SessionLogTranscript` が担い、scroll-spy はインスタンスごとに独立する。

subagent が複数あるときはヘッダ下に subagent タブを出し、右ペインに出す 1 つを選ぶ。
subagent が無ければ Main のみを全幅表示し、タブも右ペインも出さない。

タブバーは Task ツール subagent (`workflowRunId` 空) をフラットなチップ列で、Workflow ツール
agent を `workflowRunId` ごとにグループ化して workflow 名見出し付きで並べる。3 階層
(main → workflow → agent) を 2 ペインに畳むため、main の `Workflow` 行リンクは「グループ
先頭 agent を開く」入口に徹し、残りはグループのチップから辿らせる。

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
  parseSessionLog,
  sessionLogDirOf,
  type ParsedSessionLog,
  type SubagentLink,
} from "./sessionLog";
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
// Task ツール subagent (workflowRunId 空) は従来通りフラットなチップ列で出す。
const plainSubagents = computed<SessionTab[]>(() =>
  subagents.value.filter((s) => s.workflowRunId === ""),
);
// workflow agent は workflowRunId でグループ化する (出現順を保持)。
interface WorkflowGroup {
  runId: string;
  name: string;
  agents: SessionTab[];
}
const workflowGroups = computed<WorkflowGroup[]>(() => {
  const groups = new Map<string, WorkflowGroup>();
  for (const s of subagents.value) {
    if (s.workflowRunId === "") continue;
    const existing = groups.get(s.workflowRunId);
    if (existing === undefined) {
      // 見出し名は workflowName 優先。空なら runId をそのまま見出しに使う。
      groups.set(s.workflowRunId, {
        runId: s.workflowRunId,
        name: s.workflowName !== "" ? s.workflowName : s.workflowRunId,
        agents: [s],
      });
    } else {
      existing.agents.push(s);
    }
  }
  return [...groups.values()];
});

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

// クリックされた tool 呼び出しの ts。subagent ペインをこの ts へジャンプさせる。
// nonce は同一 subagent / 同一 ts の再クリックでも子の watch を発火させるための単調増加値。
const scrollTarget = ref<{ ts: string; nonce: number } | undefined>(undefined);
let scrollNonce = 0;

// main のボタンクリック: 対応 subagent を右ペインに出し、その ts へ同期スクロールする。
function openSubagent(payload: { agentId: string; ts: string }) {
  activeSubId.value = payload.agentId;
  scrollTarget.value = { ts: payload.ts, nonce: ++scrollNonce };
}

/**
 * subagent タブのラベル。workflow agent は `phaseTitle · label` で phase 文脈を出す。
 * それ以外は meta.json の description / agentType を優先、無ければ agentId 先頭。
 */
function subagentLabel(entry: {
  id: string;
  label: string;
  agentType: string;
  phaseTitle: string;
}): string {
  if (entry.phaseTitle !== "" && entry.label !== "") return `${entry.phaseTitle} · ${entry.label}`;
  if (entry.label !== "") return entry.label;
  if (entry.agentType !== "") return entry.agentType;
  return entry.id.slice(0, 8);
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
    label: entry.kind === "main" ? "Main" : subagentLabel(entry),
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
  scrollTarget.value = undefined;

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
  // subagent があれば先頭を右ペインに初期表示する。
  activeSubId.value = subagents.value[0]?.id;
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
  // 選択中の subagent が消えていたら先頭へ寄せる (computed は sessions.value から再評価される)。
  if (activeSubId.value !== undefined && !subagents.value.some((s) => s.id === activeSubId.value)) {
    activeSubId.value = subagents.value[0]?.id;
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

// タブからの手動選択は時刻ジャンプを伴わない。古い scrollTarget が残ったまま別 subagent を
// remount すると onMounted が誤って旧 ts へ飛ばすため、選択時にクリアして先頭表示に倒す。
function selectSubagent(id: string) {
  activeSubId.value = id;
  scrollTarget.value = undefined;
}

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

      <!-- subagent タブ。右ペインに出す 1 つを選ぶ。subagent が無ければ出さない。
           Task ツール subagent はフラットなチップ列、Workflow agent は workflow ごとに
           グループ化して見出し付きで並べる。 -->
      <div
        v-if="subagents.length > 0"
        class="flex shrink-0 flex-col gap-1.5 border-b border-zinc-800 px-3 py-2"
      >
        <!-- Task ツール subagent (フラット) -->
        <div v-if="plainSubagents.length > 0" class="flex flex-wrap items-center gap-1">
          <span class="mr-1 text-[10px] tracking-wide text-zinc-500 uppercase">Subagents</span>
          <button
            v-for="s in plainSubagents"
            :key="s.id"
            type="button"
            class="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition-colors"
            :class="
              activeSubId === s.id
                ? 'bg-zinc-700 text-zinc-100'
                : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            "
            :title="s.id"
            @click="selectSubagent(s.id)"
          >
            <span class="icon-[lucide--git-fork] size-3 shrink-0" />
            <span class="max-w-40 truncate">{{ s.label }}</span>
          </button>
        </div>

        <!-- Workflow agent (workflow ごとにグループ化) -->
        <div
          v-for="group in workflowGroups"
          :key="group.runId"
          class="flex flex-wrap items-center gap-1"
        >
          <span
            class="mr-1 flex items-center gap-1 text-[10px] tracking-wide text-zinc-500 uppercase"
            :title="group.runId"
          >
            <span class="icon-[lucide--workflow] size-3 shrink-0" />
            <span class="max-w-44 truncate">{{ group.name }}</span>
          </span>
          <button
            v-for="s in group.agents"
            :key="s.id"
            type="button"
            class="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition-colors"
            :class="
              activeSubId === s.id
                ? 'bg-zinc-700 text-zinc-100'
                : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            "
            :title="s.id"
            @click="selectSubagent(s.id)"
          >
            <span class="max-w-40 truncate">{{ s.label }}</span>
          </button>
        </div>
      </div>

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
          :session-key="mainSession.id"
          :subagent-links="mainSubagentLinks"
          class="min-w-0 flex-1"
          @open-subagent="openSubagent"
        />

        <!-- 右: 選択中の subagent (あれば横並び)。scrollTo で呼び出し時刻へ同期する。 -->
        <SessionLogTranscript
          v-if="!loading && !errorMessage && !notFound && activeSub"
          :key="activeSub.id"
          :parsed="activeSub.parsed"
          :session-key="activeSub.id"
          :scroll-to="scrollTarget"
          class="min-w-0 flex-1 border-l border-zinc-800"
        />
      </div>
    </div>
  </dialog>
</template>
