<script setup lang="ts">
import { ref, watch } from "vue";
import type { UnsavedDraftConfirm } from "./useUnsavedDraftConfirm";

interface Props {
  confirm: UnsavedDraftConfirm;
}

const props = defineProps<Props>();
const { pending, saving, cancel, chooseSave, chooseDiscard } = props.confirm;
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

// 保存中は ESC / Cancel での取り下げを受け付けない。dialog だけ閉じても chooseSave は進行中で、
// Cancel したように見えたあと保存完了で proceed (close・ファイル切替) が走るため
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
