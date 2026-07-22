<doc lang="md">
未保存 draft を破棄する操作の確認 dialog (Save / Don't Save / Cancel)。

`useUnsavedDraftConfirm` の pending が SSOT。ClosePaneConfirmDialog と同じく、ユーザー操作
(backdrop / ESC) は native `dialog.close()` を起点にし `@close` → `cancel()` だけが pending を
畳む。Save / Don't Save は各 choose が pending を先に消化するため、後続の close → cancel は
no-op になり二重実行しない。

Save 実行中は全ボタンを無効化し、ESC (native `cancel` event) も preventDefault で止める。
保存の進行とダイアログの取り下げが競合すると「Cancel したのに保存後の proceed が走る」
順序が観察されるため、save 中は取り下げ自体を受け付けない。
</doc>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useUnsavedDraftConfirm } from "./useUnsavedDraftConfirm";

const { pending, saving, cancel, chooseSave, chooseDiscard } = useUnsavedDraftConfirm();
const dialogRef = ref<HTMLDialogElement | undefined>(undefined);

watch(pending, (next) => {
  const dialog = dialogRef.value;
  if (dialog === undefined) return;
  if (next === undefined) {
    if (dialog.open) dialog.close();
    return;
  }
  // 既に open な <dialog> への showModal は InvalidStateError を投げるためガードする
  if (!dialog.open) dialog.showModal();
});

function requestDismiss() {
  if (saving.value) return;
  dialogRef.value?.close();
}

function onDialogClick(event: MouseEvent) {
  if (event.target === dialogRef.value) requestDismiss();
}

function onNativeCancel(event: Event) {
  if (saving.value) event.preventDefault();
}
</script>

<template>
  <dialog
    ref="dialogRef"
    class="backdrop:bg-overlay"
    @click="onDialogClick"
    @close="cancel"
    @cancel="onNativeCancel"
  >
    <div
      class="flex max-w-96 flex-col gap-4 rounded-lg border border-border bg-background p-4 text-foreground"
    >
      <div class="flex flex-col gap-1">
        <p class="text-sm">Do you want to save the changes you made to {{ pending?.fileName }}?</p>
        <p class="text-xs text-foreground-low">Your changes will be lost if you don't save them.</p>
      </div>
      <div class="flex items-center justify-between gap-2">
        <button
          type="button"
          class="rounded-sm px-3 py-1.5 text-sm text-destructive-text hover:bg-destructive-subtle disabled:text-foreground-muted"
          :disabled="saving"
          @click="chooseDiscard"
        >
          Don't Save
        </button>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded-sm px-3 py-1.5 text-sm text-foreground-low hover:bg-panel disabled:text-foreground-muted"
            :disabled="saving"
            @click="requestDismiss"
          >
            Cancel
          </button>
          <button
            type="button"
            class="rounded-sm bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary-hover disabled:bg-element disabled:text-foreground-muted"
            :disabled="saving"
            @click="chooseSave"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  </dialog>
</template>
