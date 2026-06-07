<doc lang="md">
ターミナル右上に常駐する Claude session の最新メッセージ preview。

`leafId` から PTY → session_id を辿り、`useSessionLogLive` で session ログをライブ取得する
(SessionLogDialog と同じ composable / 同じ debounce regimen)。

## 表示

固定幅で main / sub 各 2 行ずつの LINE 風吹き出しレイアウト:

- **Main**: 最終 user 発言 (上 / 右寄せ) / 最終 assistant 発言 (下 / 左寄せ)
- **Sub**: 最後に発話のあった subagent 1 つの最終 user (上 / 右寄せ) / 最終 assistant (下 / 左寄せ)

吹き出しの非対称な角丸 (`rounded-tl-sm` / `rounded-tr-sm`) と色 (panel / success-subtle) は
SessionLogTranscript と共有して dialog 全体の視覚規律に揃える。各メッセージは 1 行 truncate。
session 未起動 / subagent 不在ならその段を出さない。

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

// kind を逆走査で 1 件取り、最終発話の text + ts を返す。空文字を出さないため text が
// 空のものは飛ばして次を探す (tool_result / 注入された空 user 等の取りこぼし対策)。
function lastMessageOf(
  events: TranscriptEvent[],
  kind: "user" | "assistant",
): { text: string; ts: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === kind && e.text !== "") return { text: e.text, ts: e.ts };
  }
  return undefined;
}

// bubble 表示用に 1 行目だけを抽出する。markdown コードフェンス / リスト / 複数段落を含む
// 投稿でも overlay の縦領域が膨らまないよう、文字列レベルで構造を切る (CSS の truncate
// だけでは改行を持つ multi-line textnode を畳めない)。popover 側は openPreview に全文を
// 渡すので、ここで切り詰めた値とは独立して動く。
function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.slice(0, idx);
}

interface PreviewMessage {
  kind: "user" | "assistant";
  text: string;
  ts: string;
}

// user / assistant の最終発話を集めて古い順 (ts 昇順) で返す。両方無ければ空配列。
// 古い順にすると LINE と同じ時系列読みになる (上から下が時間の経過方向)。
function collectPair(events: TranscriptEvent[]): PreviewMessage[] {
  const user = lastMessageOf(events, "user");
  const assistant = lastMessageOf(events, "assistant");
  const arr: PreviewMessage[] = [];
  if (user !== undefined) arr.push({ kind: "user", text: user.text, ts: user.ts });
  if (assistant !== undefined)
    arr.push({ kind: "assistant", text: assistant.text, ts: assistant.ts });
  arr.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return arr;
}

const mainPair = computed<PreviewMessage[]>(() => {
  const main = sessions.value.find((s) => s.kind === "main");
  if (main === undefined) return [];
  return collectPair(parsedEvents(main.content));
});

// 最後に発話があった subagent 1 つを選ぶ。「発話」は kind 問わず events 末尾の ts を見る
// (tool だけ走っている subagent も走った時刻として最新性に寄与する)。
const subPair = computed<PreviewMessage[]>(() => {
  const subs = sessions.value
    .filter((s) => s.kind !== "main")
    .map((s) => ({ tab: s, events: parsedEvents(s.content) }))
    .filter((x) => x.events.length > 0);
  if (subs.length === 0) return [];
  let newest = subs[0];
  let newestMs = lastTs(newest.events);
  for (let i = 1; i < subs.length; i++) {
    const ms = lastTs(subs[i].events);
    if (ms > newestMs) {
      newestMs = ms;
      newest = subs[i];
    }
  }
  return collectPair(newest.events);
});

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

// preview の表示自体は session が無いか、main / sub どちらの行も空のときは出さない。
const hasContent = computed(() => {
  if (sessionId.value === undefined) return false;
  return mainPair.value.length > 0 || subPair.value.length > 0;
});
</script>

<template>
  <div
    v-if="hasContent"
    class="pointer-events-none absolute top-1 right-3 z-10 flex w-88 max-w-[50%] flex-col gap-1 rounded-md bg-background/70 p-2 text-xs/tight"
  >
    <div v-if="mainPair.length > 0" class="flex flex-col gap-0.5">
      <span class="text-[10px] font-semibold text-foreground-low">main</span>
      <div
        v-for="msg in mainPair"
        :key="msg.kind"
        class="flex"
        :class="msg.kind === 'user' ? 'justify-end' : ''"
      >
        <button
          type="button"
          class="pointer-events-auto max-w-[85%] cursor-pointer truncate rounded-lg px-2 py-0.5 text-left hover:brightness-110"
          :class="
            msg.kind === 'user'
              ? 'rounded-tr-sm bg-success-subtle text-success-text'
              : 'rounded-tl-sm bg-panel text-foreground'
          "
          :title="msg.text"
          @click="openPreview($event, msg.text, msg.kind)"
        >
          {{ firstLine(msg.text) }}
        </button>
      </div>
    </div>
    <div v-if="subPair.length > 0" class="flex flex-col gap-0.5">
      <span class="text-[10px] font-semibold text-foreground-low">sub</span>
      <div
        v-for="msg in subPair"
        :key="msg.kind"
        class="flex"
        :class="msg.kind === 'user' ? 'justify-end' : ''"
      >
        <button
          type="button"
          class="pointer-events-auto max-w-[85%] cursor-pointer truncate rounded-lg px-2 py-0.5 text-left hover:brightness-110"
          :class="
            msg.kind === 'user'
              ? 'rounded-tr-sm bg-success-subtle text-success-text'
              : 'rounded-tl-sm bg-panel text-foreground'
          "
          :title="msg.text"
          @click="openPreview($event, msg.text, msg.kind)"
        >
          {{ firstLine(msg.text) }}
        </button>
      </div>
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
        class="rounded-md bg-panel px-3 py-2 text-foreground [--md-code-bg:var(--color-element)]"
      >
        <MarkdownBody :content="previewContext.text" />
      </div>
      <div
        v-else
        class="rounded-md bg-success-subtle px-3 py-2 wrap-break-word whitespace-pre-wrap text-success-text"
      >
        {{ previewContext.text }}
      </div>
    </template>
  </PreviewPopover>
</template>
