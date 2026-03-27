<doc lang="md">
Popover API (`popover="manual"`) によるトースト通知。

## 動作

- 通知が存在する間 popover を open にし、空になったら hide する
- error は手動クローズのみ、info は自動消去（store 側で管理）
- 複数通知は下から上へスタック表示
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";

const { notifications, dismiss } = useNotificationStore();

const popoverRef = useTemplateRef<HTMLElement>("popover");

// 通知の有無に応じて popover を開閉
watch(
  () => notifications.value.length,
  (len) => {
    const el = popoverRef.value;
    if (!el) return;
    if (len > 0 && !el.matches(":popover-open")) {
      el.showPopover();
    } else if (len === 0 && el.matches(":popover-open")) {
      el.hidePopover();
    }
  },
);

// popover が外部要因で閉じられた場合に全通知をクリア
useEventListener(popoverRef, "toggle", (e: ToggleEvent) => {
  if (e.newState === "closed") {
    for (const n of notifications.value) {
      dismiss(n.id);
    }
  }
});

const iconMap = {
  error: "icon-[lucide--circle-x]",
  info: "icon-[lucide--info]",
} as const;

const colorMap = {
  error: "border-red-800 bg-red-950",
  info: "border-zinc-700 bg-zinc-900",
} as const;

const iconColorMap = {
  error: "text-red-400",
  info: "text-blue-400",
} as const;
</script>

<template>
  <div
    ref="popover"
    popover="manual"
    class="_notification-toast pointer-events-none m-0 flex flex-col items-end gap-2 border-0 bg-transparent p-4 [&:popover-open]:flex"
  >
    <div
      v-for="n in notifications"
      :key="n.id"
      :class="[
        'pointer-events-auto flex max-w-md items-start gap-2 rounded-lg border p-3 text-sm text-white shadow-lg',
        colorMap[n.type],
      ]"
    >
      <span :class="['mt-0.5 size-4 shrink-0', iconMap[n.type], iconColorMap[n.type]]" />
      <p class="min-w-0 flex-1 break-all">{{ n.message }}</p>
      <button
        type="button"
        class="shrink-0 text-zinc-400 hover:text-zinc-200"
        aria-label="Dismiss"
        @click="dismiss(n.id)"
      >
        <span class="icon-[lucide--x] size-4" />
      </button>
    </div>
  </div>
</template>

<style>
._notification-toast {
  inset: unset;
  bottom: 0;
  right: 0;
  max-height: none;
}
</style>
