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
import NotificationToastItem from "./NotificationToastItem.vue";

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
</script>

<template>
  <div
    ref="popover"
    popover="manual"
    class="_notification-toast pointer-events-none m-0 flex flex-col items-end gap-2 border-0 bg-transparent p-4 [&:popover-open]:flex"
  >
    <NotificationToastItem
      v-for="n in notifications"
      :key="n.id"
      :type="n.type"
      :message="n.message"
      :cause="n.cause"
      @dismiss="dismiss(n.id)"
    />
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
