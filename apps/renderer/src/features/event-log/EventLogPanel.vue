<doc lang="md">
観測イベントログのパネル。`shared/debug` の ring buffer を時系列 (新しい順) に表示し、
`channel:label` ごとの累計回数を要約する。PR poll 等の「どのくらい実行されているか」を
**prod 込み**で観測する診断用途 (DEV 限定にしない)。

## 設計判断

- ServerListPanel と同じ右ドック popover 流儀 (`popover="manual"` で top layer、ESC 自前閉じ)。
  z-index 競争から構造的に離脱するため。開閉 SSOT は useEventLogStore、ログの SSOT は shared/debug
- 時刻は ms まで出す。frequency 観測が主目的で、秒単位だと連続発火の間隔が潰れるため
- label 別に色を振り、実行 (fire/trailing) / 抑止 (coalesced/skip) / 失敗 (error) を一目で区別する
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { computed, useTemplateRef, watch } from "vue";
import { writeClipboardText } from "../../shared/clipboard";
import { useDebugLog } from "../../shared/debug";
import { useNotificationStore } from "../../shared/notification";
import { useEventLogStore } from "./useEventLogStore";
import IconLucideActivity from "~icons/lucide/activity";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideX from "~icons/lucide/x";

const store = useEventLogStore();
const { events, counts, clear } = useDebugLog();
const notify = useNotificationStore();

/** 新しい順。ring buffer は push 順 (古い → 新しい) なので反転する。 */
const reversed = computed(() => [...events.value].reverse());

/** 1 event を表示と同じ体裁の 1 行テキストにする（copy all / 将来の書式共有用）。 */
function fmtLine(e: {
  t: number;
  channel: string;
  label: string;
  repo: string;
  detail: string;
}): string {
  const parts = [fmtTime(e.t), `[${e.channel}]`, e.label];
  if (e.repo) parts.push(e.repo);
  if (e.detail) parts.push(e.detail);
  return parts.join(" ");
}

/** 全 event を時系列（古い順）のプレーンテキストでクリップボードへ。バグ報告に貼れるよう
 * 表示の newest-first ではなくログ慣習の oldest-first で出す。 */
async function copyAll(): Promise<void> {
  const text = events.value.map(fmtLine).join("\n");
  const result = await writeClipboardText(text);
  if (result.ok) {
    notify.info("Event log copied to clipboard");
  } else {
    notify.error("Failed to copy event log", result.error);
  }
}

/** epoch ms → HH:MM:SS.mmm。frequency 観測のため ms まで出す。 */
function fmtTime(t: number): string {
  const d = new Date(t);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** label 別の色。fire/trailing=実行, coalesced/in-flight=抑止, skip/stale=非対象, error=失敗, その他=文脈。 */
const LABEL_CLASS: Record<string, string> = {
  fire: "text-success-text",
  trailing: "text-success-text",
  done: "text-foreground-low",
  coalesced: "text-warning-text",
  "in-flight": "text-warning-text",
  "skip:blur": "text-foreground-muted",
  skip: "text-foreground-muted",
  stale: "text-foreground-muted",
  error: "text-destructive-text",
};
function labelClass(label: string): string {
  return LABEL_CLASS[label] ?? "text-primary-text";
}

// popover="manual" のため OS の auto dismiss が無い。ESC を自前で受けて閉じる
// (ServerListPanel と同じく前面 modal dialog には譲る)。
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (e.defaultPrevented) return;
  if (e.code !== "Escape" || !store.isOpen) return;
  if (document.querySelector("dialog[open]") !== null) return;
  e.preventDefault();
  store.close();
});

const panelRef = useTemplateRef<HTMLElement>("panel");
// template ref が null に戻った時点 (unmount) に bindPopover(undefined) で dangling を切る。
watch(panelRef, (el) => store.bindPopover(el ?? undefined), { immediate: true });
</script>

<template>
  <div
    ref="panel"
    popover="manual"
    class="_event-log-popover w-[420px] flex-col border-0 border-l border-border bg-panel p-0 shadow-xl [&:popover-open]:flex"
  >
    <header class="flex items-center gap-2 border-b border-border px-3 py-2">
      <IconLucideActivity class="size-4 text-foreground-low" />
      <h2 class="flex-1 text-sm font-medium text-foreground">Event log</h2>
      <button
        type="button"
        aria-label="Copy all"
        :disabled="events.length === 0"
        class="grid size-6 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        @click="copyAll()"
      >
        <IconLucideCopy class="size-4" />
      </button>
      <button
        type="button"
        aria-label="Clear"
        class="grid size-6 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
        @click="clear()"
      >
        <IconLucideTrash2 class="size-4" />
      </button>
      <button
        type="button"
        aria-label="Close"
        class="grid size-6 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
        @click="store.close()"
      >
        <IconLucideX class="size-4" />
      </button>
    </header>

    <!-- store.isOpen で内容をゲートする。閉じている間は counts / reversed を読まないため、背景 event
         ごとの再描画 (最大 500 行) が止まる。short-circuit で computed 依存も張られない (ring buffer への
         記録は logEvent 側で継続)。 -->
    <!-- 要約: channel:label ごとの累計回数 -->
    <div
      v-if="store.isOpen && counts.length > 0"
      class="flex flex-wrap gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-[11px] text-foreground-low select-text"
    >
      <span v-for="[key, n] in counts" :key="key" class="tabular-nums">
        {{ key }} <span class="font-semibold text-foreground">{{ n }}</span>
      </span>
    </div>

    <div
      v-if="store.isOpen && reversed.length === 0"
      class="px-3 py-8 text-center text-xs text-foreground-low"
    >
      No events recorded yet
    </div>

    <div
      v-else-if="store.isOpen"
      class="min-h-0 flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed select-text"
    >
      <div
        v-for="e in reversed"
        :key="e.id"
        class="flex items-baseline gap-2 border-b border-border-subtle px-3 py-0.5"
      >
        <span class="shrink-0 text-foreground-muted tabular-nums">{{ fmtTime(e.t) }}</span>
        <span class="shrink-0 text-foreground-low">[{{ e.channel }}]</span>
        <span class="shrink-0 font-semibold" :class="labelClass(e.label)">{{ e.label }}</span>
        <span v-if="e.repo" class="shrink-0 text-foreground">{{ e.repo }}</span>
        <span v-if="e.detail" class="min-w-0 truncate text-foreground-low">{{ e.detail }}</span>
      </div>
    </div>
  </div>
</template>

<style>
._event-log-popover {
  /* タイトルバー (drag 領域) を覆わないよう、上端をその直下に置き右端に沿わせる (ServerListPanel と同流儀) */
  inset: unset;
  margin: 0;
  top: var(--titlebar-height);
  right: 0;
  bottom: 0;
  /* UA スタイル [popover] { height: fit-content } を打ち消し、top + bottom の伸縮を効かせる */
  height: auto;
  max-height: none;
}
</style>
