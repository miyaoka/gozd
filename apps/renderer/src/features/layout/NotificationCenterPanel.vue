<doc lang="md">
Notification center パネル。auto-dismiss で消えた toast も含む全通知の受け皿
（VS Code の notification center と同役割）。toast は一時表示、center は永続記録という
分業で、auto-dismiss が silent drop にならないことを構造的に保証する。

## 設計判断

- EventLogPanel / ServerListPanel と同じ右ドック popover 流儀 (`popover="manual"` で
  top layer、ESC 自前閉じ)。開閉 SSOT は useNotificationCenterStore、通知データの SSOT は
  shared/notification
- 表示順は seq 降順（新着順）。重複抑制で集約された項目は再発生のたびに seq が進むため、
  再発生した通知が自動的に先頭へ浮上する
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { computed, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import NotificationCenterItem from "./NotificationCenterItem.vue";
import { useNotificationCenterStore } from "./useNotificationCenterStore";
import IconLucideBell from "~icons/lucide/bell";
import IconLucideTrash2 from "~icons/lucide/trash-2";
import IconLucideX from "~icons/lucide/x";

const store = useNotificationCenterStore();
const { notifications, remove, clear } = useNotificationStore();

/** 新着順。seq は発生 (再発生含む) ごとに進む単調増加値。 */
const sorted = computed(() => [...notifications.value].sort((a, b) => b.seq - a.seq));

// popover="manual" のため OS の auto dismiss が無い。ESC を自前で受けて閉じる
// (EventLogPanel と同じく前面 modal dialog には譲る)。
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
    class="_notification-center-popover w-[420px] flex-col border-0 border-l border-border bg-panel p-0 shadow-xl [&:popover-open]:flex"
  >
    <header class="flex items-center gap-2 border-b border-border px-3 py-2">
      <IconLucideBell class="size-4 text-foreground-low" />
      <h2 class="flex-1 text-sm font-medium text-foreground">Notifications</h2>
      <button
        type="button"
        aria-label="Clear all"
        :disabled="notifications.length === 0"
        class="grid size-6 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground disabled:pointer-events-none disabled:text-foreground-muted"
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

    <div
      v-if="store.isOpen && sorted.length === 0"
      class="px-3 py-8 text-center text-xs text-foreground-low"
    >
      No notifications
    </div>

    <div v-else-if="store.isOpen" class="min-h-0 flex-1 overflow-y-auto">
      <NotificationCenterItem
        v-for="n in sorted"
        :key="n.id"
        :notification="n"
        @remove="remove(n.id)"
      />
    </div>
  </div>
</template>

<style>
._notification-center-popover {
  /* タイトルバー (drag 領域) を覆わないよう、上端をその直下に置き右端に沿わせる (EventLogPanel と同流儀) */
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
