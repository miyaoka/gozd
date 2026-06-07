<doc lang="md">
ターミナル右上に常駐する Claude session の最新メッセージ preview。

`leafId` から PTY → session_id を辿り、`useSessionLogLive` で session ログをライブ取得する
(SessionLogDialog と同じ composable / 同じ debounce regimen)。

## 表示

main / sub を独立した 2 つの overlay に分け、terminal の右上に main、右下に sub を
配置する。1 つの overlay に縦積みすると main と sub の境界が読み取りにくいため、
物理的距離で分離する設計。

各 overlay の内側は user / assistant それぞれ最終 2 発言 (合計 4 件まで) を ts 昇順で
混ぜて並べる。user は右寄せ + `bg-chat-outgoing` (LINE 緑) + 黒文字、assistant は
左寄せ + `bg-chat-incoming` (暗グレー) + 白文字の LINE ダーク風吹き出し。角丸は対称
(話者方向を示す尖り角は付けない)。

「kind ごとに 2 件確保 → ts でマージ」順で並べるため、assistant が連続応答するケース
でも user の最近 2 件が落ちず、対話の流れが追える。各 bubble は span ラップした
`line-clamp-2` で 2 行省略する (WebKit の button native renderer が
`-webkit-box-orient: vertical` を無視するため、button 直下では line-clamp が効かず
中間 span に逃がしている)。bubble が 0 件の overlay は非表示にし、両 overlay とも空なら
何も描画しない。

## sub の subagent ラベル

sub overlay の先頭に `subagentTabLabel` 由来の subagent ラベル (Task / workflow agent)
を出し、どの subagent の発話なのかを明示する。ラベルは `<details><summary>` で
括られており、native の open/close で bubble 群を折りたためる。状態は Vue 側に持たず
`<details>` の `open` 属性が SSOT。

## 全文 preview

各 bubble クリックで HTML Popover API ベースの全文ポップオーバーを開く。Popover は
`shared/popover` の `usePopover` を per-instance で使い、anchor は被クリック bubble。
CSS anchor positioning (`positionArea` + `positionTryFallbacks`) で画面端に押し出された
ときは反対側へ flip する。
</doc>

<script setup lang="ts">
import { computed, ref } from "vue";
import { usePopover } from "../../shared/popover";
import { MarkdownBody } from "../preview";
import { parseSessionLog, useSessionLogLive, type TranscriptEvent } from "../session-log";
import { useTerminalStore } from "./useTerminalStore";

interface Props {
  leafId: string;
}

const props = defineProps<Props>();
const terminalStore = useTerminalStore();

// leafId → ptyId → sessionId の辿り。`sessionIdByPtyId` は reactive Map なので
// `getSessionIdByPtyId` の結果がそのまま reactivity に乗る。session-start で entry が
// 立った時点で computed が再評価され、session-end での delete でも追随する。
const sessionId = computed<string | undefined>(() => {
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

// 最後に「会話発話」(kind === user | assistant) があった ts。tool だけ走り続けている
// subagent (大規模 grep / spawn) はここの最新性に寄与させない。tool ts まで含めると
// 実際に対話している subagent が押し出されて preview の主役が反転するため。
function lastConversationTs(events: TranscriptEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind !== "user" && e.kind !== "assistant") continue;
    const ms = Date.parse(e.ts);
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

// main session の events。サブで二度評価されるのを避けるため computed に切る。
const mainEvents = computed<TranscriptEvent[]>(() => {
  const main = sessions.value.find((s) => s.kind === "main");
  return main === undefined ? [] : parsedEvents(main.content);
});

// 最後に発話があった subagent 1 つの events + 表示ラベル (subagentTabLabel が組み立てた
// agent 名 / workflow 見出し)。「発話」は会話イベント (user / assistant) の最終 ts で判定し、
// tool 単独走行の subagent はここでの最新性に寄与させない。events と label を 1 つの
// computed にまとめておくと sub overlay の見出しと本文が同じ subagent から派生する不変条件を
// 構造的に担保できる。
const newestSub = computed<{ label: string; events: TranscriptEvent[] } | undefined>(() => {
  const subs = sessions.value
    .filter((s) => s.kind !== "main")
    .map((s) => ({ label: s.label, events: parsedEvents(s.content) }))
    .filter((x) => x.events.length > 0);
  if (subs.length === 0) return undefined;
  let newest = subs[0];
  let newestMs = lastConversationTs(newest.events);
  for (let i = 1; i < subs.length; i++) {
    const ms = lastConversationTs(subs[i].events);
    if (ms > newestMs) {
      newestMs = ms;
      newest = subs[i];
    }
  }
  return newest;
});
const subEvents = computed<TranscriptEvent[]>(() => newestSub.value?.events ?? []);
const subLabel = computed<string | undefined>(() => newestSub.value?.label);

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
// PreviewMessage を context にそのまま渡し、popover 側は kind / text しか参照しない
// (ts は無視される)。型を分けず 1 つにまとめて conversion を消す。
// per-instance: コンポーネント unmount で effect scope が自動破棄されるため stop 不要。
const {
  Popover: PreviewPopover,
  context: previewContext,
  open: openPreviewPopover,
} = usePopover<PreviewMessage>();

function openPreview(event: MouseEvent, msg: PreviewMessage) {
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement)) return;
  openPreviewPopover(anchor, msg);
}

// sub overlay の折り畳み状態。`<details>` の `open` 属性を SSOT にすると subagent
// 切替で <details> が unmount → mount される度に静的 `open` で展開状態に戻ってしまうため、
// Vue 側 ref を SSOT にして `<details :open="subOpen">` でバインドし、`@toggle` で同期する。
const subOpen = ref(true);
function onSubToggle(event: Event) {
  if (!(event.target instanceof HTMLDetailsElement)) return;
  subOpen.value = event.target.open;
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
    class="pointer-events-none absolute top-1 right-3 z-10 flex w-56 max-w-[35%] flex-col gap-1 rounded-md bg-background/70 p-2 text-xs/tight"
  >
    <div
      v-for="msg in mainMessages"
      :key="`${msg.kind}-${msg.ts}`"
      class="flex min-w-0"
      :class="msg.kind === 'user' ? 'justify-end' : ''"
    >
      <button
        type="button"
        class="pointer-events-auto block max-w-[85%] cursor-pointer rounded-lg px-2 py-1 text-left hover:brightness-110"
        :class="
          msg.kind === 'user'
            ? 'bg-chat-outgoing text-chat-outgoing-text'
            : 'bg-chat-incoming text-chat-incoming-text'
        "
        :title="msg.text"
        @click="openPreview($event, msg)"
      >
        <span class="line-clamp-2">{{ msg.text }}</span>
      </button>
    </div>
  </div>

  <!-- sub: 右下。main と同じ LINE 風シーケンス。物理的距離で main との混在を回避する。
       最上段に subagent ラベル (subagentTabLabel が組み立てた agent 名 / workflow 見出し)
       を出し、どの subagent の発話なのかを明示する。 -->
  <div
    v-if="hasSub"
    class="pointer-events-none absolute right-3 bottom-1 z-10 flex w-56 max-w-[35%] flex-col gap-1 rounded-md bg-background/70 p-2 text-xs/tight"
  >
    <details :open="subOpen" class="contents" @toggle="onSubToggle">
      <summary
        v-if="subLabel"
        class="pointer-events-auto cursor-pointer truncate px-1 text-xs font-semibold text-foreground-low hover:text-foreground [&::-webkit-details-marker]:hidden [&::marker]:hidden"
        :title="subLabel"
      >
        {{ subLabel }}
      </summary>
      <div
        v-for="msg in subMessages"
        :key="`${msg.kind}-${msg.ts}`"
        class="flex min-w-0"
        :class="msg.kind === 'user' ? 'justify-end' : ''"
      >
        <button
          type="button"
          class="pointer-events-auto block max-w-[85%] cursor-pointer rounded-lg px-2 py-1 text-left hover:brightness-110"
          :class="
            msg.kind === 'user'
              ? 'bg-chat-outgoing text-chat-outgoing-text'
              : 'bg-chat-incoming text-chat-incoming-text'
          "
          :title="msg.text"
          @click="openPreview($event, msg)"
        >
          <span class="line-clamp-2">{{ msg.text }}</span>
        </button>
      </div>
    </details>
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
