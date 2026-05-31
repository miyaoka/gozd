<doc lang="md">
task ⋮ メニューの「Show session log」から開くセッションログ表示 dialog。
`useSessionLogViewer` の context (`sessionId` + `title`) が定義されたら開く。

## レイアウト

ヘッダ下にセッションタブ (main + subagents、subagent が無ければ非表示)、その下に
左目次 (user / assistant のみ、見出しは時刻) + 右トランスクリプト本文の 2 カラム。
目次クリックで該当イベントへスクロールし、`IntersectionObserver` で現在地を
ハイライトする。

右トランスクリプトは LINE のトーク画面に倣ったチャット表示。user (貼り付け画像
含む) を自分として右寄せ、assistant を左寄せの吹き出しにする。話者は左右寄せ +
緑/zinc の塗り分けで識別できるため、アバターや話者アイコンは置かない。
thinking / tool は LINE に対応物が無いため、中央寄せの控えめなシステム行に畳む。

## 動作

- open 時に `rpcClaudeSessionLog` で native から main + subagents の生 JSONL を取得し、
  各 entry を `parseSessionLog` で transcript 化して 1 タブ = 1 セッションとして保持する。
  タブ切替で active セッションを変え、目次 / 本文 / footer が追従する
- user / image は緑の吹き出しで右寄せ (自分)、assistant は zinc の吹き出しで左寄せ (相手)。
  話者は左右寄せ + 緑/zinc の塗り分けで識別でき、アバター / 話者アイコンは持たない。
  時刻は吹き出しの下端脇に小さく置く
- thinking / tool は中央寄せの非塗りシステム行 (`<details>`) に畳み、デフォルト閉じ。会話
  (塗り吹き出し) と「塗り面か否か」で峻別する (休止状態は塗り無し、hover のみ feedback)。
  開くと本文に thinking 平文 / tool の input + 実行結果を出す。見出しは tool 名 (weight で
  primary) + error (引数の前) + 主要引数 (file_path 等は basename) で、アイコンや hue 装飾は
  持たず、状態色は error の red のみ
- assistant は markdown 記述なので preview feature の `MarkdownBody` で描画する。
  user / thinking は `whitespace-pre-wrap` の素テキスト
- image イベントは base64 source を data URL にして `<img>` 描画する (吹き出し背景なし)
- 時刻は今日なら時刻のみ、別日は日付前置 (resume で日 / 年をまたぐケースの区別)

## 設計判断

- 吹き出し (user / assistant / image) は常時表示、システム行 (thinking / tool) のみ
  `<details>` のネイティブ開閉に委ね、Vue 側に per-event の ref を持たない
- scroll-spy は `IntersectionObserver`。純 CSS の scroll marker / `:target-current` は
  WebKit (Safari 26 / macOS 26) 未対応のため使えない。チャット行の最外要素に `data-ev`
  を残し、user / assistant 行を index で観測する
- 取得失敗 / 未発見 / 空ログはそれぞれ明示メッセージを出す (fallback で握り潰さない)
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { MarkdownBody } from "../preview";
import { rpcClaudeSessionLog } from "./rpc";
import { parseSessionLog, type ParsedSessionLog, type TranscriptEvent } from "./sessionLog";
import SessionLogToolArg from "./SessionLogToolArg.vue";
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

// role ごとの色 (SSOT)。目次のドットと吹き出しが同一 role には必ず同一 hue を使う。
// LINE に倣い自分 (user) を緑、相手 (assistant) を無彩 zinc にし、アクセント hue は緑 1 つに絞る。
// 目次の時刻テキストは role 非依存の neutral にし (色の責務をドットに閉じる)、緑の高視感度が
// 時刻ラベルの可読性を role で揺らさないようにする。
const ROLE_COLOR: Record<"user" | "assistant", string> = {
  user: "text-green-400",
  assistant: "text-zinc-400",
};

// thinking と tool はデフォルト閉じる (思考過程とツール詳細はノイズになりやすく、
// user / assistant の会話を読みやすくするため)。中央システム行として畳んだ状態で見せる。
const DEFAULT_COLLAPSED = new Set<EventKind>(["thinking", "tool"]);
function defaultOpen(kind: EventKind): boolean {
  return !DEFAULT_COLLAPSED.has(kind);
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
  if (log.emptyThinking > 0) parts.push(`${log.emptyThinking} empty thinking hidden`);
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
  activeId.value = undefined;

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
    // 進行中の load を無効化し、close 後に stale 結果が state を書き戻すのを防ぐ。
    loadToken++;
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
          <!-- subagent は派生関係を表す fork 記号のみ残す。main はラベル "Main" で足りる -->
          <span v-if="s.kind !== 'main'" class="icon-[lucide--git-fork] size-3 shrink-0" />
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
            class="flex w-full items-center gap-1.5 border-l-2 px-3 py-1 text-left text-[11px] text-zinc-300 tabular-nums transition-colors hover:bg-white/5"
            :class="
              activeIndex === entry.index
                ? 'border-zinc-400 bg-white/10 font-semibold'
                : 'border-transparent opacity-70'
            "
            @click="scrollToEvent(entry.index)"
          >
            <!-- role 識別はこのドット 1 点に閉じる (テキストは neutral) -->
            <span
              class="size-1.5 shrink-0 rounded-full bg-current"
              :class="ROLE_COLOR[entry.kind]"
            />
            <span class="truncate">{{ entry.time || "—" }}</span>
          </button>
        </nav>

        <!-- 右: トランスクリプト本文 (LINE 風チャット) -->
        <div
          v-if="activeParsed && activeParsed.events.length > 0"
          ref="contentRef"
          class="flex-1 space-y-3 overflow-y-auto px-4 py-3"
        >
          <template v-for="(ev, i) in activeParsed.events" :key="`${sessionKey}:${i}`">
            <!-- thinking / tool: 中央寄せの控えめなシステム行 (デフォルト閉じ) -->
            <details
              v-if="ev.kind === 'thinking' || ev.kind === 'tool'"
              :data-ev="i"
              :open="defaultOpen(ev.kind)"
              class="scroll-mt-2"
            >
              <!-- 控えめなシステム行。会話 (塗り吹き出し) と「塗り面か否か」で峻別するため、
                   休止状態は塗り無しの中央寄せ素テキストにする (LINE のシステム通知に倣う)。
                   hover の塗りは操作 feedback のみで、休止状態の形は吹き出しと衝突させない。
                   アイコン / hue 装飾は持たず、主従は weight (tool 名 = primary)、状態色は
                   error の red のみ。秒時刻は会話吹き出し側で足りるため出さない。 -->
              <summary
                class="mx-auto flex w-fit max-w-[70%] cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-zinc-500 select-none hover:bg-white/5 [&::-webkit-details-marker]:hidden"
              >
                <span v-if="ev.kind === 'thinking'">thinking</span>
                <template v-else>
                  <!-- tool 名 = primary (weight)。error は引数 truncate に押し出されないよう名直後。 -->
                  <span class="shrink-0 font-mono font-medium text-zinc-300">{{ ev.name }}</span>
                  <span
                    v-if="ev.result?.isError"
                    class="shrink-0 rounded-sm bg-red-500/20 px-1 whitespace-nowrap text-red-300"
                    >error</span
                  >
                  <SessionLogToolArg :input="ev.input" />
                </template>
              </summary>

              <!-- thinking 平文 -->
              <div
                v-if="ev.kind === 'thinking'"
                class="mx-auto mt-1 max-w-[85%] rounded-md bg-white/5 px-3 py-2 text-sm wrap-break-word whitespace-pre-wrap text-zinc-400"
              >
                {{ ev.text }}
              </div>
              <!-- tool: input 全体 + 実行結果 -->
              <div
                v-else
                class="mx-auto mt-1 max-w-[85%] space-y-2 rounded-md bg-white/5 px-3 py-2"
              >
                <pre
                  class="overflow-x-auto rounded-sm bg-zinc-800 p-2 text-xs text-zinc-300"
                ><code>{{ formatInput(ev.input) }}</code></pre>
                <div v-if="ev.result">
                  <p class="mb-1 text-[10px] text-zinc-500">
                    {{ ev.result.isError ? "Error output" : "Output" }}
                  </p>
                  <pre
                    class="max-h-72 overflow-auto rounded-sm bg-zinc-800 p-2 text-xs"
                    :class="ev.result.isError ? 'text-red-300' : 'text-zinc-300'"
                  ><code>{{ ev.result.text }}</code></pre>
                </div>
                <p v-else class="text-[10px] text-zinc-500 italic">(no result recorded)</p>
              </div>
            </details>

            <!-- user / image (自分, 右寄せ) と assistant (相手, 左寄せ) の吹き出し。
                 話者は左右寄せ + 緑/zinc の塗り分けで識別でき、アバターは置かない。 -->
            <div
              v-else
              :data-ev="i"
              class="flex scroll-mt-2 items-end gap-1.5"
              :class="ev.kind === 'assistant' ? 'flex-row' : 'flex-row-reverse'"
            >
              <!-- assistant: markdown 吹き出し (相手色 zinc-800)。
                   MarkdownBody はコードブロック背景を暗地前提の zinc-800 で固定するため、
                   塗りを被せると地より暗いブロックが浮く明度反転になる。`--md-code-bg` で地より
                   一段明るい zinc-700 を渡し、preview と同じ「地 < code」の明度順を保つ。 -->
              <div
                v-if="ev.kind === 'assistant'"
                class="min-w-0 rounded-2xl rounded-tl-sm bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 [--md-code-bg:var(--color-zinc-700)]"
              >
                <MarkdownBody
                  :content="ev.text"
                  @link-click="onAssistantLinkClick"
                  @rendered="onMarkdownRendered"
                />
              </div>

              <!-- user: 素テキスト吹き出し (自分色)。LINE の自分発話に倣い緑塗り。
                   緑は唯一のアクセントとし、相手 (無彩) と hue で 1 つだけ差をつける。暗 UI
                   (zinc-900 地) で面が主張しすぎないよう緑は一段暗い green-800 に抑える。 -->
              <div
                v-else-if="ev.kind === 'user'"
                class="min-w-0 rounded-2xl rounded-tr-sm bg-green-800 px-3 py-2 text-sm wrap-break-word whitespace-pre-wrap text-green-50"
              >
                {{ ev.text }}
              </div>

              <!-- image: 吹き出し背景なしで素の角丸画像。source 不明なら placeholder。 -->
              <img
                v-else-if="ev.kind === 'image' && ev.src"
                :src="ev.src"
                alt="session log image"
                class="max-h-96 max-w-[75%] rounded-2xl border border-zinc-700"
              />
              <span
                v-else-if="ev.kind === 'image'"
                class="max-w-[75%] rounded-2xl bg-zinc-800 px-3 py-2 text-sm text-zinc-500 italic"
                >(image content unavailable)</span
              >

              <!-- 時刻は吹き出しの下端脇に小さく -->
              <span class="shrink-0 pb-0.5 text-[10px] text-zinc-600 tabular-nums">{{
                formatTime(ev.ts)
              }}</span>
            </div>
          </template>
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
