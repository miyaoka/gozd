<doc lang="md">
編集モードの list 行（ListRow）の ⋮ ボタンから開くポップオーバーメニュー。
Rename / Delete list… を提供する。

rename / delete を常時ボタンで露出させないのは、特に delete が気軽に押す操作ではないため。
メニュー → （delete は）確認ダイアログの二段階で明示操作に限定する。実処理は SidebarPane が
emit を受けて行い、state は `useListMenu`（module singleton）経由で共有する。

Delete は最後の 1 個では無効化する（store 側 `removeRepoList` の拒否と二重だが、
押せないことを見た目で伝える）。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { useRepoStore } from "../../shared/repo";
import { useListMenu } from "./useListMenu";
import IconLucidePencil from "~icons/lucide/pencil";
import IconLucideTrash2 from "~icons/lucide/trash-2";

const emit = defineEmits<{
  rename: [listId: string];
  remove: [listId: string];
}>();

const { Popover, context, close } = useListMenu();
const repoStore = useRepoStore();

const isLastList = computed(() => repoStore.repoLists.length <= 1);

function handleRename() {
  if (!context.value) return;
  const { listId } = context.value;
  close();
  emit("rename", listId);
}

function handleRemove() {
  if (!context.value) return;
  const { listId } = context.value;
  close();
  emit("remove", listId);
}
</script>

<template>
  <Popover
    class="m-0 min-w-36 rounded-lg border border-border bg-background py-1 text-sm text-foreground shadow-lg"
    :style="{
      position: 'fixed',
      positionArea: 'block-end span-inline-end',
      positionTryFallbacks: 'flip-block, flip-inline, flip-block flip-inline',
    }"
  >
    <template v-if="context">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel"
        @click="handleRename"
      >
        <IconLucidePencil class="text-xs" />
        Rename
      </button>
      <button
        :disabled="isLastList"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-destructive-text hover:bg-panel disabled:cursor-not-allowed disabled:text-foreground-muted disabled:hover:bg-transparent"
        @click="handleRemove"
      >
        <IconLucideTrash2 class="text-xs" />
        Delete list…
      </button>
    </template>
  </Popover>
</template>
