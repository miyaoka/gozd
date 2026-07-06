<doc lang="md">
Claude が作業中 (working) の terminal pane を閉じる前の確認 dialog。

`useClosePaneConfirm` の pendingAction が SSOT。ユーザー操作 (Cancel / backdrop / ESC) は
すべて native `dialog.close()` を起点にし、`@close` → `cancel()` だけが pendingAction を
undefined に同期する。OK は `confirm()` で pendingAction を消化し、watch 経由で同じ close
経路に乗る（cancel は no-op になり二重実行しない）。
</doc>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useClosePaneConfirm } from "./useClosePaneConfirm";

const { pendingAction, cancel, confirm } = useClosePaneConfirm();
const dialogRef = ref<HTMLDialogElement | undefined>(undefined);

watch(pendingAction, (next) => {
  const dialog = dialogRef.value;
  if (dialog === undefined) return;
  if (next === undefined) {
    if (dialog.open) dialog.close();
    return;
  }
  // 既に open な <dialog> への showModal は InvalidStateError を投げるためガードする
  if (!dialog.open) dialog.showModal();
});

function requestClose() {
  dialogRef.value?.close();
}

function onDialogClick(event: MouseEvent) {
  if (event.target === dialogRef.value) requestClose();
}
</script>

<template>
  <dialog ref="dialogRef" class="backdrop:bg-overlay" @click="onDialogClick" @close="cancel">
    <div class="space-y-4 rounded-lg border border-border bg-background p-4 text-foreground">
      <p class="text-sm">Claude is still working in this terminal. Close it anyway?</p>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="rounded-sm px-3 py-1.5 text-sm text-foreground-low hover:bg-panel"
          @click="requestClose"
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-sm bg-destructive px-3 py-1.5 text-sm text-foreground hover:bg-destructive-hover"
          @click="confirm"
        >
          Close
        </button>
      </div>
    </div>
  </dialog>
</template>
