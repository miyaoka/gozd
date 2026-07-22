<doc lang="md">
repo list 名の編集 dialog。`useListEditing` の context (`listId`) が定義されたら開く。

rename の唯一の経路（list 行の ⋮ メニュー → Rename）。インライン編集は持たない。

## 設計判断

- list は `useRepoStore` から listId で引き直す。open 中に他経路で削除されたら自動 close
- 空 / whitespace-only は Save を disable する。list 名は表示の識別子なので空を許さない
  （空許容 + フォールバック表示を持つ task の userTitle とはここが違う）
</doc>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { useListEditing } from "./useListEditing";

const { context, close } = useListEditing();
const repoStore = useRepoStore();

const dialogRef = ref<HTMLDialogElement | undefined>(undefined);
const inputRef = ref<HTMLInputElement | undefined>(undefined);
const draft = ref("");

const currentList = computed(() => {
  const ctx = context.value;
  if (ctx === undefined) return undefined;
  return repoStore.repoLists.find((p) => p.id === ctx.listId);
});

// open 中に list が消えたら（他インスタンスの削除等）dialog を閉じる
watch(currentList, (list) => {
  if (context.value !== undefined && list === undefined) close();
});

watch(context, (next) => {
  if (next === undefined) {
    dialogRef.value?.close();
    return;
  }
  draft.value = currentList.value?.name ?? "";
  dialogRef.value?.showModal();
  queueMicrotask(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
});

const canSave = computed(() => draft.value.trim() !== "");

function save() {
  const list = currentList.value;
  if (list === undefined) return;
  const next = draft.value.trim();
  if (next === "") return;
  if (next !== list.name) repoStore.renameRepoList(list.id, next);
  close();
}

// バックドロップクリックで close
function onDialogClick(event: MouseEvent) {
  if (event.target === dialogRef.value) close();
}
</script>

<template>
  <dialog
    ref="dialogRef"
    class="m-auto bg-transparent p-0 backdrop:bg-overlay"
    @click="onDialogClick"
    @close="close"
  >
    <div
      v-if="currentList"
      class="w-80 space-y-4 rounded-lg border border-border bg-background p-4 text-foreground shadow-xl"
    >
      <h2 class="text-sm font-semibold">Rename list</h2>
      <input
        ref="inputRef"
        v-model="draft"
        type="text"
        aria-label="List name"
        class="w-full rounded-sm bg-panel px-2 py-1 text-sm text-foreground ring-1 ring-border outline-none focus:ring-ring"
        @keydown.enter.prevent="save"
        @keydown.escape.prevent="close"
      />
      <div class="flex justify-end gap-2 pt-2">
        <button
          type="button"
          class="rounded-sm px-3 py-1.5 text-sm text-foreground-low hover:bg-panel"
          @click="close"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="!canSave"
          class="rounded-sm bg-primary px-3 py-1.5 text-sm text-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-element disabled:text-foreground-muted"
          @click="save"
        >
          Save
        </button>
      </div>
    </div>
  </dialog>
</template>
