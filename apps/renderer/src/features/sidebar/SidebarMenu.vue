<doc lang="md">
共有 ⋮ ポップオーバーメニュー。

worktree カード / task 行から呼ばれ、コンテキストに応じたアクション (Remove worktree /
Remove task) を表示する。`showPopover({ source })` の implicit anchor で ⋮ ボタンの直下に
配置する。

親から `openMenu()` を expose 経由で呼び出してメニューを開く。
アクション選択時は emit で親に通知し、メニューを閉じる。
</doc>

<script setup lang="ts">
import type { Task, WorktreeEntry } from "@gozd/proto";
import { nextTick, ref } from "vue";

const emit = defineEmits<{
  worktreeRemove: [wt: WorktreeEntry, rootDir: string];
  taskRemove: [task: Task, rootDir: string];
}>();

type MenuContext =
  | { type: "worktree"; worktree: WorktreeEntry; rootDir: string }
  | { type: "task"; task: Task; rootDir: string };

/**
 * showPopover に渡す `source` 引数の型。
 * Popover API の最新仕様（HTMLElement.showPopover(options)）。
 * lib.dom.d.ts への取り込みが追いついていないため最小宣言を持つ。
 */
type ShowPopoverOptions = { source?: HTMLElement };
type PopoverElement = HTMLElement & { showPopover(options?: ShowPopoverOptions): void };

const menuRef = ref<PopoverElement>();
const menuContext = ref<MenuContext>();

function openMenu(anchorEl: HTMLElement, context: MenuContext) {
  menuContext.value = context;
  nextTick(() => {
    menuRef.value?.showPopover({ source: anchorEl });
  });
}

function closeMenu() {
  menuRef.value?.hidePopover();
}

function handleWorktreeRemove(wt: WorktreeEntry, rootDir: string) {
  closeMenu();
  emit("worktreeRemove", wt, rootDir);
}

function handleTaskRemove(task: Task, rootDir: string) {
  closeMenu();
  emit("taskRemove", task, rootDir);
}

defineExpose({ openMenu });
</script>

<template>
  <div
    ref="menuRef"
    popover="auto"
    class="m-0 min-w-36 rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-lg"
    :style="{
      top: 'anchor(bottom)',
      left: 'anchor(left)',
    }"
  >
    <template v-if="menuContext?.type === 'worktree' && menuContext.worktree">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
        @click="handleWorktreeRemove(menuContext.worktree, menuContext.rootDir)"
      >
        <span class="icon-[lucide--unlink] text-xs" />
        Remove worktree
      </button>
    </template>
    <template v-else-if="menuContext?.type === 'task' && menuContext.task">
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-zinc-800"
        @click="handleTaskRemove(menuContext.task, menuContext.rootDir)"
      >
        <span class="icon-[lucide--trash-2] text-xs" />
        Remove task
      </button>
    </template>
  </div>
</template>

<style scoped>
[popover] {
  position: fixed;
  position-try-fallbacks: flip-block, flip-inline;
}
</style>
