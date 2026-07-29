<doc lang="md">
Popover API (`popover="manual"`) によるトースト通知。

## 動作

- toast 表示中の通知（store の `toasts` view）が存在する間 popover を open にし、空になったら hide する
- 全 type とも type 別の寿命で自動消去（store 側で管理）。見逃しは notification center で回収する
- window blur 中は全 toast の自動消去を保留し、focus 復帰でフル時間から再開する（VS Code の
  purge ガードと同じ。見ていない間にカウントダウンが進んで戻ったら消えていた、を防ぐ）
- dismiss は toast を畳むだけで、通知自体は notification center に残る
- 複数通知は下から上へスタック表示
</doc>

<script setup lang="ts">
import { useEventListener, useWindowFocus } from "@vueuse/core";
import { onBeforeUnmount, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { pinSurface, unpinSurface } from "../../shared/surface";
import NotificationToastItem from "./NotificationToastItem.vue";

const { toasts, dismiss, setAutoDismissSuspended } = useNotificationStore();

// window blur 中は自動消去を保留する（VS Code の onDidChangeFocus 相当）
const windowFocused = useWindowFocus();
watch(windowFocused, (focused) => setAutoDismissSuspended(!focused), { immediate: true });

const popoverRef = useTemplateRef<HTMLElement>("popover");

// トーストは click-to-front の列に加えず常にサーフェスより手前へ留める (shared/surface の
// pin セクション)。エラー通知の一次表示がパネルに埋もれると失敗の可視性が落ちるため。
// 解除は onBeforeUnmount で行う: unmount は「beforeUnmount → effect scope 停止 → subtree
// unmount (template ref が null)」の順なので、watch も onUnmounted も element を掴めない。
watch(popoverRef, (el) => {
  if (el !== null) pinSurface(el);
});
onBeforeUnmount(() => {
  const el = popoverRef.value;
  if (el !== null) unpinSurface(el);
});

// toast の有無に応じて popover を開閉
watch(
  () => toasts.value.length,
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

// popover が外部要因で閉じられた場合に全 toast を畳む（center には残る）。
// pin の積み直し (hide → show) が挟む中間 close は畳まない: toggle は task-queued なので、
// ハンドラが走る時点では既に再 open 済みで `:popover-open` に一致する（usePopover と同じ判定軸）。
useEventListener(popoverRef, "toggle", (e: ToggleEvent) => {
  if (e.newState === "closed" && popoverRef.value?.matches(":popover-open") !== true) {
    for (const n of toasts.value) {
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
      v-for="n in toasts"
      :key="n.id"
      :id="n.id"
      :type="n.type"
      :message="n.message"
      :has-details="n.cause !== undefined"
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
