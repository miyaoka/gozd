<doc lang="md">
ターミナル右上に常駐する Claude session の最新メッセージ preview。

`leafId` から PTY → session_id を辿り、`useSessionLogLive` で session ログをライブ取得する
(SessionLogDialog と同じ composable / 同じ debounce regimen)。

## 表示

main / sub を独立した 2 つの overlay に分け、terminal の右上に main、右下に sub を
配置する。1 つの overlay に縦積みすると main と sub の境界が読み取りにくいため、
物理的距離で分離する設計。

各 overlay の内側は user / assistant それぞれ最終 2 発言 (合計 4 件まで) を ts 昇順で
混ぜて並べる。user は右寄せ + `bg-success-subtle` + `rounded-tr-sm`、assistant は左寄せ

- `bg-panel` + `rounded-tl-sm` の LINE 風吹き出し。

「kind ごとに 2 件確保 → ts でマージ」順で並べるため、assistant が連続応答するケース
でも user の最近 2 件が落ちず、対話の流れが追える。各 bubble は 1 行 truncate。bubble
が 0 件の overlay は非表示にし、両 overlay とも空なら何も描画しない。

## 全文 preview

各 bubble クリックで HTML Popover API ベースの全文ポップオーバーを開く。Popover は
`shared/popover` の `usePopover` を per-instance で使い、anchor は被クリック bubble。
CSS anchor positioning (`positionArea` + `positionTryFallbacks`) で画面端に押し出された
ときは反対側へ flip する。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { usePopover } from "../../shared/popover";
import { MarkdownBody } from "../preview";
import { parseSessionLog, useSessionLogLive, type TranscriptEvent } from "../session-log";
import { useTerminalStore } from "./useTerminalStore";

interface Props {
  leafId: string;
}

const props = defineProps<Props>();
const terminalStore = useTerminalStore();

// leafId → ptyId → sessionId の辿り。getClaudeState の戻り値を依存に取り込むことで
// session-start / session-end 経由の状態変化 (claudeStatusByPtyId は reactive Ref)
// に追随して再評価される。生 Map (sessionIdByPtyId) 単独だと reactivity に乗らない
// ため、claudeState の有無を proxy として参照する。
const sessionId = computed<string | undefined>(() => {
  const state = terminalStore.getClaudeState(props.leafId);
  if (state === undefined) return undefined;
  const ptyId = terminalStore.getPtyId(props.leafId);
  if (ptyId === undefined) return undefined;
  return terminalStore.getSessionIdByPtyId(ptyId);
});

const { sessions } = useSessionLogLive(sessionId);

// JSONL を都度 parse する。preview は最新の user / assistant 1 件しか使わないため
// branchSelection は不要 (parseSessionLog は未指定で最新枝にフォールバックする)。
function parsedEvents(content: string): TranscriptEvent[] {
  return parseSessionLog(content).events;
}

function lastTs(events: TranscriptEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const ms = Date.parse(events[i].ts);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

// kind を逆走査で n 件まで集め、最終発話の text + ts を新しい順で返す。空文字は出さない
// (tool_result / 注入された空 user 等の取りこぼし対策)。呼び出し側で他 kind と merge して
// ts 昇順に並べ替える前提なので、ここでの並び順自体は最終表示に影響しない。
function lastNMessagesOf(
  events: TranscriptEvent[],
  kind: "user" | "assistant",
  n: number,
): Array<{ text: string; ts: string }> {
  const out: Array<{ text: string; ts: string }> = [];
  for (let i = events.length - 1; i >= 0 && out.length < n; i--) {
    const e = events[i];
    if (e.kind === kind && e.text !== "") out.push({ text: e.text, ts: e.ts });
  }
  return out;
}

// bubble 表示用に 1 行目だけを抽出する。markdown コードフェンス / リスト / 複数段落を含む
// 投稿でも overlay の縦領域が膨らまないよう、文字列レベルで構造を切る (CSS の truncate
// だけでは改行を持つ multi-line textnode を畳めない)。popover 側は openPreview に全文を
// 渡すので、ここで切り詰めた値とは独立して動く。
function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.slice(0, idx);
}

// main session の events。サブで二度評価されるのを避けるため computed に切る。
const mainEvents = computed<TranscriptEvent[]>(() => {
  const main = sessions.value.find((s) => s.kind === "main");
  return main === undefined ? [] : parsedEvents(main.content);
});

// 最後に発話があった subagent 1 つの events。「発話」は kind 問わず events 末尾の ts を
// 見る (tool だけ走っている subagent も走った時刻として最新性に寄与する)。
const subEvents = computed<TranscriptEvent[]>(() => {
  const subs = sessions.value
    .filter((s) => s.kind !== "main")
    .map((s) => parsedEvents(s.content))
    .filter((events) => events.length > 0);
  if (subs.length === 0) return [];
  let newest = subs[0];
  let newestMs = lastTs(newest);
  for (let i = 1; i < subs.length; i++) {
    const ms = lastTs(subs[i]);
    if (ms > newestMs) {
      newestMs = ms;
      newest = subs[i];
    }
  }
  return newest;
});

// 1 overlay 分の bubble シーケンス。各 kind から最大 2 件取り、ts 昇順でマージする。
// LINE 同様の時系列読みになる (上から下が時間の経過方向)。
interface PreviewMessage {
  kind: "user" | "assistant";
  text: string;
  ts: string;
}
const MESSAGES_PER_KIND = 2;
function collectMessages(events: TranscriptEvent[]): PreviewMessage[] {
  const users = lastNMessagesOf(events, "user", MESSAGES_PER_KIND).map((m) => ({
    kind: "user" as const,
    text: m.text,
    ts: m.ts,
  }));
  const assistants = lastNMessagesOf(events, "assistant", MESSAGES_PER_KIND).map((m) => ({
    kind: "assistant" as const,
    text: m.text,
    ts: m.ts,
  }));
  return [...users, ...assistants].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
const mainMessages = computed<PreviewMessage[]>(() => collectMessages(mainEvents.value));
const subMessages = computed<PreviewMessage[]>(() => collectMessages(subEvents.value));

// クリックで全文を出す popover。kind は吹き出し色を合わせるための discriminator。
// per-instance: コンポーネント unmount で effect scope が自動破棄されるため stop 不要。
interface PreviewContext {
  text: string;
  kind: "user" | "assistant";
}
const {
  Popover: PreviewPopover,
  context: previewContext,
  open: openPreviewPopover,
} = usePopover<PreviewContext>();

function openPreview(event: MouseEvent, text: string, kind: "user" | "assistant") {
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement)) return;
  openPreviewPopover(anchor, { text, kind });
}

// 各 overlay は bubble が 1 件でもあれば出す。session が無いときは events が空なので
// collectMessages も空配列を返し、副次的にカバーされる。
const hasMain = computed(() => mainMessages.value.length > 0);
const hasSub = computed(() => subMessages.value.length > 0);
</script>

<template>
  <!-- main: 右上。user / assistant 各最大 2 件を時系列順に LINE 風吹き出しで並べる -->
  <div
    v-if="hasMain"
    class="pointer-events-none absolute top-1 right-3 z-10 flex w-[18rem] max-w-[40%] flex-col gap-0.5 p-2 text-xs/tight"
  >
    <div
      v-for="msg in mainMessages"
      :key="`${msg.kind}-${msg.ts}`"
      class="flex"
      :class="msg.kind === 'user' ? 'justify-end' : ''"
    >
      <button
        type="button"
        class="pointer-events-auto max-w-[85%] cursor-pointer truncate rounded-lg px-2 py-0.5 text-left hover:brightness-110"
        :class="
          msg.kind === 'user'
            ? 'bg-chat-outgoing text-chat-outgoing-text'
            : 'bg-chat-incoming text-chat-incoming-text'
        "
        :title="msg.text"
        @click="openPreview($event, msg.text, msg.kind)"
      >
        {{ firstLine(msg.text) }}
      </button>
    </div>
  </div>

  <!-- sub: 右下。main と同じ LINE 風シーケンス。物理的距離で main との混在を回避する -->
  <div
    v-if="hasSub"
    class="pointer-events-none absolute right-3 bottom-1 z-10 flex w-[18rem] max-w-[40%] flex-col gap-0.5 p-2 text-xs/tight"
  >
    <div
      v-for="msg in subMessages"
      :key="`${msg.kind}-${msg.ts}`"
      class="flex"
      :class="msg.kind === 'user' ? 'justify-end' : ''"
    >
      <button
        type="button"
        class="pointer-events-auto max-w-[85%] cursor-pointer truncate rounded-lg px-2 py-0.5 text-left hover:brightness-110"
        :class="
          msg.kind === 'user'
            ? 'bg-chat-outgoing text-chat-outgoing-text'
            : 'bg-chat-incoming text-chat-incoming-text'
        "
        :title="msg.text"
        @click="openPreview($event, msg.text, msg.kind)"
      >
        {{ firstLine(msg.text) }}
      </button>
    </div>
  </div>

  <!-- 全文 preview popover。anchor は被クリックの bubble、`positionTryFallbacks` で
       端に押し出されたら反対側へ flip。light-dismiss (popover 外 click / ESC) で閉じる。
       assistant 側のみ MarkdownBody で描画 (SessionLogTranscript と同じ規律: user 投稿は
       素のテキストとして書かれる前提で markdown 解釈しない)。 -->
  <PreviewPopover
    class="m-0 max-h-[60vh] w-lg max-w-[80vw] overflow-auto rounded-lg border border-border bg-background p-3 text-base shadow-lg"
    :style="{
      position: 'fixed',
      positionArea: 'block-end span-inline-start',
      positionTryFallbacks: 'flip-block, flip-inline, flip-block flip-inline',
    }"
  >
    <template v-if="previewContext">
      <div
        v-if="previewContext.kind === 'assistant'"
        class="_preview-assistant rounded-md bg-chat-incoming px-3 py-2 text-chat-incoming-text [--color-foreground-low:var(--color-chat-incoming-text-low)] [--color-foreground:var(--color-chat-incoming-text)] [--md-code-bg:transparent]"
      >
        <MarkdownBody :content="previewContext.text" />
      </div>
      <div
        v-else
        class="rounded-md bg-chat-outgoing px-3 py-2 wrap-break-word whitespace-pre-wrap text-chat-outgoing-text"
      >
        {{ previewContext.text }}
      </div>
    </template>
  </PreviewPopover>
</template>

<style scoped>
/* MarkdownBody は `_markdown-body :deep(code) { color: var(--color-foreground); ... }` で
   inline code を一様に染めるため、本文 (`p` / `h*` 等) を黒文字にしたまま code だけ紫に
   するには CSS 変数 override では足りない。`_preview-assistant` scope に :deep(code) を
   足して specificity を MarkdownBody 側と同等以上に持ち上げる。 */
._preview-assistant :deep(code) {
  color: var(--color-chat-code);
}
</style>
