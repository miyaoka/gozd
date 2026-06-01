<doc lang="md">
task ⋮ メニューの「Show session log」から開くセッションログ表示 dialog。
`useSessionLogViewer` の context (`sessionId` + `title`) が定義されたら開く。

## レイアウト

Main セッションを左ペインに常時表示し、subagent があれば選択中の 1 つを右ペインに
横並びで同時表示する (2 ペイン)。各ペインの中身 (目次 + チャット本文 + footer) は
`SessionLogTranscript` が担い、scroll-spy はインスタンスごとに独立する。

subagent が複数あるときはヘッダ下に subagent タブを出し、右ペインに出す 1 つを選ぶ。
subagent が無ければ Main のみを全幅表示し、タブも右ペインも出さない。

## 動作

- open 時に `rpcClaudeSessionLog` で native から main + subagents の生 JSONL を取得し、
  各 entry を `parseSessionLog` で transcript 化して保持する。`entries[0]` が main、
  残りが subagents。subagent タブを選ぶと右ペインの transcript が切り替わる
- 取得失敗 / 未発見 / 空ログはそれぞれ明示メッセージを出す (fallback で握り潰さない)
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcClaudeSessionLog } from "./rpc";
import { parseSessionLog, type ParsedSessionLog } from "./sessionLog";
import SessionLogTranscript, { type SubagentLink } from "./SessionLogTranscript.vue";
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
  parsed: ParsedSessionLog;
}
const sessions = ref<SessionTab[]>([]);
// entries[0] が main。subagents はそれ以降。
const mainSession = computed<SessionTab | undefined>(() =>
  sessions.value.find((s) => s.kind === "main"),
);
const subagents = computed<SessionTab[]>(() => sessions.value.filter((s) => s.kind !== "main"));

// 右ペインに出す subagent。subagent が 1 つでもあれば先頭を初期選択する。
const activeSubId = ref<string | undefined>(undefined);
const activeSub = computed<SessionTab | undefined>(() =>
  subagents.value.find((s) => s.id === activeSubId.value),
);

// main の Agent / SendMessage 呼び出しを subagent に結ぶ。key は main の tool event の
// toolUseId、value は紐づく subagent の {agentId,label}。
// - Agent (新規 spawn): main tool_use.id === subagent meta.toolUseId (= parentToolUseId)
// - SendMessage (resume): main tool_use.input.to === subagent agent_id (= id)
// 両者を 1 つの map に畳み、main ペインは tool event の toolUseId 1 本で引ける。
const mainSubagentLinks = computed<Map<string, SubagentLink>>(() => {
  const links = new Map<string, SubagentLink>();
  const main = mainSession.value;
  if (main === undefined) return links;

  const byParentToolUse = new Map<string, SessionTab>();
  const byAgentId = new Map<string, SessionTab>();
  for (const sub of subagents.value) {
    if (sub.parentToolUseId !== "") byParentToolUse.set(sub.parentToolUseId, sub);
    byAgentId.set(sub.id, sub);
  }

  for (const ev of main.parsed.events) {
    if (ev.kind !== "tool") continue;
    if (ev.name === "Agent") {
      const sub = byParentToolUse.get(ev.toolUseId);
      if (sub !== undefined) links.set(ev.toolUseId, { agentId: sub.id, label: sub.label });
    } else if (ev.name === "SendMessage") {
      const to = ev.input.to;
      if (typeof to === "string") {
        const sub = byAgentId.get(to);
        if (sub !== undefined) links.set(ev.toolUseId, { agentId: sub.id, label: sub.label });
      }
    }
  }
  return links;
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

/** subagent タブのラベル。meta.json の description / agentType を優先、無ければ agentId。 */
function subagentLabel(entry: { id: string; label: string; agentType: string }): string {
  if (entry.label !== "") return entry.label;
  if (entry.agentType !== "") return entry.agentType;
  return entry.id.slice(0, 8);
}

// load の世代カウンタ。await を跨いだ stale な完了結果が新しいセッション表示を
// 上書きするのを防ぐ。新規 load 開始 / dialog close のたびに increment し、await 後に
// 自分の token が最新でなければ state を触らず捨てる。
let loadToken = 0;

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
  sessions.value = result.value.entries.map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    label: entry.kind === "main" ? "Main" : subagentLabel(entry),
    parentToolUseId: entry.parentToolUseId,
    parsed: parseSessionLog(entry.content),
  }));
  // subagent があれば先頭を右ペインに初期表示する。
  activeSubId.value = subagents.value[0]?.id;
}

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

      <!-- subagent タブ。右ペインに出す 1 つを選ぶ。subagent が無ければ出さない。 -->
      <div
        v-if="subagents.length > 0"
        class="flex shrink-0 flex-wrap items-center gap-1 border-b border-zinc-800 px-3 py-2"
      >
        <span class="mr-1 text-[10px] tracking-wide text-zinc-500 uppercase">Subagents</span>
        <button
          v-for="s in subagents"
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
