<doc lang="md">
task ⋮ メニューの「Show session log」から開くセッションログ表示 dialog。
`useSessionLogViewer` の context (`sessionId` + `title`) が定義されたら開く。

## レイアウト

ヘッダ下にセッションタブ (main + subagents、subagent が無ければ非表示)、その下に
左目次 (user / assistant のみ、見出しは時刻) + 右トランスクリプト本文の 2 カラム。
目次クリックで該当イベントへスクロールし、`IntersectionObserver` で現在地を
ハイライトする。各イベント見出し (`<summary>`) は `position: sticky` で上部固定。

## 動作

- open 時に `rpcClaudeSessionLog` で native から main + subagents の生 JSONL を取得し、
  各 entry を `parseSessionLog` で transcript 化して 1 タブ = 1 セッションとして保持する。
  タブ切替で active セッションを変え、目次 / 本文 / footer が追従する
- イベントは kind ごとに色分けし、`<details>` で折り畳む。thinking / tool はデフォルト閉じ、
  user / assistant / image はデフォルト開く
- assistant は markdown 記述なので preview feature の `MarkdownBody` で描画する。
  user / thinking は `whitespace-pre-wrap` の素テキスト
- tool イベントは summary に主要引数 (command / file_path 等) のプレビュー、本文に input
  全体と実行結果 (stdout / エラー) を出す
- image イベントは base64 source を data URL にして `<img>` 描画する
- 見出しの時刻は今日なら時刻のみ、別日は日付前置 (resume で日 / 年をまたぐケースの区別)

## 設計判断

- 開閉状態は `<details open>` のネイティブ挙動に委ね、Vue 側に per-event の ref を持たない
- scroll-spy は `IntersectionObserver`。純 CSS の scroll marker / `:target-current` は
  WebKit (Safari 26 / macOS 26) 未対応のため使えない
- 取得失敗 / 未発見 / 空ログはそれぞれ明示メッセージを出す (fallback で握り潰さない)
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { MarkdownBody } from "../preview";
import { rpcClaudeSessionLog } from "./rpc";
import { parseSessionLog, type ParsedSessionLog, type TranscriptEvent } from "./sessionLog";
import { useSessionLogViewer } from "./useSessionLogViewer";

const { context, close } = useSessionLogViewer();
const notify = useNotificationStore();

const dialogRef = ref<HTMLDialogElement | undefined>(undefined);
const loading = ref(false);
const errorMessage = ref<string | undefined>(undefined);
const notFound = ref(false);

// main + subagents を 1 タブ = 1 セッションとして保持し、active を切り替えて表示する。
interface SessionTab {
  kind: string; // "main" | "subagent"
  id: string; // main は session_id、subagent は agent_id
  label: string; // タブ表示名
  parsed: ParsedSessionLog;
}
const sessions = ref<SessionTab[]>([]);
const activeId = ref<string | undefined>(undefined);
const activeParsed = computed<ParsedSessionLog | undefined>(
  () => sessions.value.find((s) => s.id === activeId.value)?.parsed,
);

type EventKind = TranscriptEvent["kind"];

/** kind ごとの表示ラベルと色 (TaskRow / preview と同系統の zinc + accent) */
const KIND_VISUAL: Record<EventKind, { label: string; labelClass: string; barClass: string }> = {
  user: { label: "USER", labelClass: "text-sky-300", barClass: "border-sky-500/40" },
  assistant: {
    label: "ASSISTANT",
    labelClass: "text-emerald-300",
    barClass: "border-emerald-500/40",
  },
  thinking: { label: "THINKING", labelClass: "text-violet-300", barClass: "border-violet-500/40" },
  tool: { label: "TOOL", labelClass: "text-amber-300", barClass: "border-amber-500/40" },
  image: { label: "IMAGE", labelClass: "text-cyan-300", barClass: "border-cyan-500/40" },
};

// thinking と tool はデフォルト閉じる (思考過程とツール詳細はノイズになりやすく、
// user / assistant の本文を読みやすくするため)。それ以外は開いた状態で見せる。
const DEFAULT_COLLAPSED = new Set<EventKind>(["thinking", "tool"]);
function defaultOpen(kind: EventKind): boolean {
  return !DEFAULT_COLLAPSED.has(kind);
}

/** tool summary に出す主要引数。代表キーを優先順で拾い、無ければ undefined。 */
const TOOL_PRIMARY_KEYS = ["command", "file_path", "path", "pattern", "query", "url"];
function toolArgPreview(input: Record<string, unknown>): string | undefined {
  for (const key of TOOL_PRIMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function formatInput(input: Record<string, unknown>): string {
  return JSON.stringify(input, null, 2);
}

/**
 * ISO timestamp を表示用に整形する。空 / 不正なら空文字。
 *
 * 今日は時刻のみ (HH:MM:SS)。別日は日付を前置し (今年は M/D、別年は YYYY/M/D)、
 * resume で日 / 年をまたいだセッションでもエントリを一意に区別できるようにする。
 */
function formatTime(ts: string): string {
  if (ts === "") return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  // 目次の一意性を時刻に頼るため、ロケール非依存で秒まで 24h 固定表示する
  // (引数なし toLocaleTimeString は環境次第で AM/PM になり tabular-nums 整列が崩れる)。
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return time;

  const sameYear = date.getFullYear() === now.getFullYear();
  const dateStr = date.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "numeric", day: "numeric" }
      : { year: "numeric", month: "numeric", day: "numeric" },
  );
  return `${dateStr} ${time}`;
}

const footerSummary = computed<string>(() => {
  const log = activeParsed.value;
  if (log === undefined) return "";
  const parts = [`${log.events.length} events`, `${log.totalLines} lines`];
  if (log.skipped > 0) parts.push(`${log.skipped} non-conversation hidden`);
  if (log.malformed > 0) parts.push(`${log.malformed} malformed`);
  return parts.join(" · ");
});

// 右ペイン本文のスクロールコンテナ。目次クリック時に該当イベント要素を引いてスクロールする。
const contentRef = ref<HTMLElement | undefined>(undefined);

// v-for の :key に active session を混ぜ、セッション切替で <details> 要素を確実に作り直す。
// index 単独だと Vue が要素を再利用し、ネイティブ <details> の open 状態が前セッションの
// 別 kind イベントに誤継承される。
const sessionKey = computed<string>(() => activeId.value ?? "");

// 左の目次は user / assistant に絞り、見出しは時刻のみ。index は本文側イベントとの対応キー。
interface TocEntry {
  index: number;
  time: string;
  kind: "user" | "assistant";
}
const tocEntries = computed<TocEntry[]>(() => {
  const log = activeParsed.value;
  if (log === undefined) return [];
  const entries: TocEntry[] = [];
  log.events.forEach((ev, index) => {
    if (ev.kind === "user" || ev.kind === "assistant") {
      entries.push({ index, time: formatTime(ev.ts), kind: ev.kind });
    }
  });
  return entries;
});

function scrollToEvent(index: number) {
  const el = contentRef.value?.querySelector(`[data-ev="${index}"]`);
  if (el instanceof HTMLElement) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// assistant markdown 内リンクのポリシー。
// session log dialog は MarkdownPreview と違い worktree 相対解決の文脈を持たないため、
// 外部 http(s) URL のみ素通しし (ExternalLinkNavigationDecider が外部ブラウザで開く)、
// それ以外 (相対パス / ルート絶対パス / protocol-relative / fragment / 他 scheme) はすべて
// 無効化する。放置すると gozd-app:// 基準で解決され WebView の main frame 置換リスクがある。
// 相対解決を意図的に行わない設計なので resolveMarkdownLink は再利用しない (ポリシーが異なる)。
const EXTERNAL_HTTP_RE = /^https?:\/\//i;
function onAssistantLinkClick(e: MouseEvent) {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const anchor = target.closest("a");
  if (anchor === null) return;
  const href = anchor.getAttribute("href");
  if (href === null) return;
  // 外部 http(s) は decider に委ねて素通し。
  if (EXTERNAL_HTTP_RE.test(href)) return;
  // それ以外は WebView 内遷移を止める。空 href はクリック対象が無いだけなので無通知。
  e.preventDefault();
  if (href !== "") {
    notify.info("Only external http(s) links are navigable in the session log viewer", { href });
  }
}

// --- scroll-spy (現在地ハイライト) ---
//
// 純 CSS の scroll marker / :target-current は WebKit 未対応 (2026-05 時点) のため、
// IntersectionObserver で「右ペイン上部バンドに入っている user/assistant イベント」を
// 検出して目次をハイライトする。bottom margin -65% で active 判定をコンテナ上部 35% に絞る。
const activeIndex = ref<number | undefined>(undefined);
let observer: IntersectionObserver | undefined;
// IntersectionObserver は変化のあった target だけを callback に渡すため、可視 index の
// 累積集合を closure に保持し、毎回そこから topmost を選ぶ。
const visibleIndices = new Set<number>();

function teardownObserver() {
  observer?.disconnect();
  observer = undefined;
  visibleIndices.clear();
  // 保留中の再 setup rAF も破棄し、observer と rAF のライフサイクルを揃える
  // (close / セッション切替後に宙に浮いた rAF が setupObserver を呼ぶのを防ぐ)。
  if (resetupRaf !== undefined) {
    cancelAnimationFrame(resetupRaf);
    resetupRaf = undefined;
  }
  resetupQueued = false;
}

function setupObserver() {
  teardownObserver();
  const root = contentRef.value;
  if (root === undefined) return;

  // 目次に出る user/assistant イベントだけを監視対象にする。
  const tocIndices = new Set(tocEntries.value.map((entry) => entry.index));

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const idx = Number((entry.target as HTMLElement).dataset.ev);
        if (Number.isNaN(idx)) continue;
        if (entry.isIntersecting) visibleIndices.add(idx);
        else visibleIndices.delete(idx);
      }
      // 可視のうち最上 (= 最小 index) を現在地にする。バンド外 (どれも非可視) のときは
      // 直前の active を保ち、スクロール中のちらつきを避ける。
      if (visibleIndices.size > 0) {
        activeIndex.value = Math.min(...visibleIndices);
      }
    },
    { root, rootMargin: "0px 0px -65% 0px", threshold: 0 },
  );

  for (const el of root.querySelectorAll<HTMLElement>("[data-ev]")) {
    const idx = Number(el.dataset.ev);
    if (tocIndices.has(idx)) observer.observe(el);
  }
}

// active session が差し替わる (タブ切替 / 別タスクを開く / 再取得) たびに observer を
// 貼り直す。contentRef は v-if でマウントされるので nextTick で DOM 反映を待つ。
watch(activeParsed, async () => {
  activeIndex.value = undefined;
  await nextTick();
  setupObserver();
});

// assistant の markdown は MarkdownBody が async (marked.parse) で描画するため、
// 上の nextTick 時点では高さがほぼ 0。描画完了 (rendered) 後に observe を貼り直さないと
// IntersectionObserver の判定が描画前レイアウトでズレる。複数ブロックの rendered が
// 連続発火するので rAF で 1 回に coalesce する。
let resetupQueued = false;
let resetupRaf: number | undefined;
function onMarkdownRendered() {
  if (resetupQueued) return;
  resetupQueued = true;
  resetupRaf = requestAnimationFrame(() => {
    resetupQueued = false;
    resetupRaf = undefined;
    setupObserver();
  });
}

onBeforeUnmount(teardownObserver);

/** subagent タブのラベル。meta.json の description / agentType を優先、無ければ agentId。 */
function subagentLabel(entry: { id: string; label: string; agentType: string }): string {
  if (entry.label !== "") return entry.label;
  if (entry.agentType !== "") return entry.agentType;
  return entry.id.slice(0, 8);
}

async function load(sessionId: string) {
  loading.value = true;
  errorMessage.value = undefined;
  notFound.value = false;
  sessions.value = [];
  activeId.value = undefined;

  const result = await tryCatch(rpcClaudeSessionLog({ sessionId }));
  loading.value = false;
  if (!result.ok) {
    errorMessage.value = result.error.message;
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
    parsed: parseSessionLog(entry.content),
  }));
  activeId.value = sessions.value[0]?.id;
}

function selectSession(id: string) {
  activeId.value = id;
}

// close 経路を片方向に統一する。ユーザー操作 (X / backdrop / ESC) はすべて native
// `dialog.close()` を起点にし、それが発火する `@close` だけが context を undefined にする
// 単一の state 同期点。context が SSOT で、この watch が open/close と observer ライフ
// サイクルを駆動する。watch 側の `dialog.close()` は外部から `close()` だけ呼ばれた
// (native close を伴わない) ケースの保険で、既に閉じていれば呼ばない。
watch(context, (next) => {
  const dialog = dialogRef.value;
  if (next === undefined) {
    teardownObserver();
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
      class="flex h-[80vh] w-[900px] max-w-[90vw] flex-col rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-100 shadow-xl"
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

      <!-- セッションタブ (main + subagents)。subagent が無ければ出さない。 -->
      <div
        v-if="sessions.length > 1"
        class="flex shrink-0 flex-wrap gap-1 border-b border-zinc-800 px-3 py-2"
      >
        <button
          v-for="s in sessions"
          :key="s.id"
          type="button"
          class="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs transition-colors"
          :class="
            activeId === s.id
              ? 'bg-zinc-700 text-zinc-100'
              : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          "
          :title="s.id"
          @click="selectSession(s.id)"
        >
          <span
            class="size-3"
            :class="s.kind === 'main' ? 'icon-[lucide--bot]' : 'icon-[lucide--git-fork]'"
          />
          <span class="max-w-40 truncate">{{ s.label }}</span>
        </button>
      </div>

      <!-- 本文: 状態メッセージ or [左 目次 + 右 トランスクリプト] -->
      <div class="flex min-h-0 flex-1">
        <!-- 状態メッセージ (loading / error / notFound / empty) は全幅 -->
        <p v-if="loading" class="px-4 py-3 text-sm text-zinc-400">Loading session log…</p>
        <p v-else-if="errorMessage" class="px-4 py-3 text-sm text-red-400">
          Failed to read session log: {{ errorMessage }}
        </p>
        <p v-else-if="notFound" class="px-4 py-3 text-sm text-zinc-400">
          No log file found for this session (not started yet, or cleaned up).
        </p>
        <p
          v-else-if="activeParsed && activeParsed.events.length === 0"
          class="px-4 py-3 text-sm text-zinc-400"
        >
          Session log has no conversation events.
        </p>

        <!-- 左: 目次 (user / assistant のみ、見出しは時刻) -->
        <nav
          v-if="activeParsed && activeParsed.events.length > 0"
          class="w-40 shrink-0 overflow-y-auto border-r border-zinc-800 py-2"
        >
          <button
            v-for="entry in tocEntries"
            :key="entry.index"
            type="button"
            class="flex w-full items-center gap-1.5 border-l-2 px-3 py-1 text-left text-[11px] tabular-nums transition-colors hover:bg-white/5"
            :class="[
              KIND_VISUAL[entry.kind].labelClass,
              activeIndex === entry.index
                ? 'border-current bg-white/10 font-semibold'
                : 'border-transparent opacity-70',
            ]"
            @click="scrollToEvent(entry.index)"
          >
            <span class="size-1.5 shrink-0 rounded-full bg-current" />
            <span class="truncate">{{ entry.time || "—" }}</span>
          </button>
        </nav>

        <!-- 右: トランスクリプト本文 -->
        <div
          v-if="activeParsed && activeParsed.events.length > 0"
          ref="contentRef"
          class="flex-1 space-y-2 overflow-y-auto px-4 pb-3"
        >
          <details
            v-for="(ev, i) in activeParsed.events"
            :key="`${sessionKey}:${i}`"
            :data-ev="i"
            :open="defaultOpen(ev.kind)"
            class="scroll-mt-2 rounded-md border-l-2 bg-white/2"
            :class="KIND_VISUAL[ev.kind].barClass"
          >
            <summary
              class="sticky top-0 z-10 flex cursor-pointer items-center gap-2 rounded-md bg-zinc-900 px-2 py-1 text-xs select-none hover:bg-zinc-800"
            >
              <span class="font-mono font-semibold" :class="KIND_VISUAL[ev.kind].labelClass">
                {{ KIND_VISUAL[ev.kind].label }}
              </span>
              <span v-if="ev.kind === 'tool'" class="font-mono text-zinc-400">· {{ ev.name }}</span>
              <span
                v-if="ev.kind === 'tool' && toolArgPreview(ev.input)"
                class="min-w-0 truncate text-zinc-500"
                :title="toolArgPreview(ev.input)"
                >{{ toolArgPreview(ev.input) }}</span
              >
              <span
                v-if="ev.kind === 'tool' && ev.result?.isError"
                class="rounded-sm bg-red-500/20 px-1 text-[10px] text-red-300"
                >error</span
              >
              <span class="ml-auto shrink-0 text-[10px] text-zinc-600 tabular-nums">{{
                formatTime(ev.ts)
              }}</span>
            </summary>

            <!-- assistant は markdown 記述なので MarkdownBody で描画する -->
            <MarkdownBody
              v-if="ev.kind === 'assistant'"
              class="px-3 py-1 text-sm"
              :content="ev.text"
              @link-click="onAssistantLinkClick"
              @rendered="onMarkdownRendered"
            />

            <!-- user 入力 / thinking は素のテキスト (markdown 意図でないことが多い) -->
            <div
              v-else-if="ev.kind === 'user' || ev.kind === 'thinking'"
              class="px-3 py-2 text-sm wrap-break-word whitespace-pre-wrap text-zinc-200"
            >
              {{ ev.text }}
            </div>

            <!-- image: base64 source は data URL で描画。source 不明なら placeholder。 -->
            <div v-else-if="ev.kind === 'image'" class="px-3 py-2">
              <img
                v-if="ev.src"
                :src="ev.src"
                alt="session log image"
                class="max-h-96 max-w-full rounded-sm border border-zinc-700"
              />
              <span v-else class="text-sm text-zinc-500 italic">(image content unavailable)</span>
            </div>

            <!-- tool -->
            <div v-else-if="ev.kind === 'tool'" class="space-y-2 px-3 py-2">
              <pre
                class="overflow-x-auto rounded-sm bg-black/30 p-2 text-xs text-zinc-300"
              ><code>{{ formatInput(ev.input) }}</code></pre>
              <div v-if="ev.result">
                <p class="mb-1 text-[10px] text-zinc-500">
                  {{ ev.result.isError ? "Error output" : "Output" }}
                </p>
                <pre
                  class="max-h-72 overflow-auto rounded-sm bg-black/30 p-2 text-xs"
                  :class="ev.result.isError ? 'text-red-300' : 'text-zinc-300'"
                ><code>{{ ev.result.text }}</code></pre>
              </div>
              <p v-else class="text-[10px] text-zinc-500 italic">(no result recorded)</p>
            </div>
          </details>
        </div>
      </div>

      <!-- フッタ -->
      <div
        v-if="activeParsed"
        class="border-t border-zinc-800 px-4 py-2 text-[10px] text-zinc-500 tabular-nums"
      >
        {{ footerSummary }}
      </div>
    </div>
  </dialog>
</template>
