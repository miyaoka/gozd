<doc lang="md">
1 つの repo を表すサイドバーセクション。

ヘッダ (chevron + folder アイコン + repo 名 + 編集モード時の ✕) と、
配下の WtCard 列 (main wt 先頭固定、その後 worktrees 配列順) + `+ New worktree`。

## 並び順

1. main wt
2. その他 wt: repoStore.worktrees の append 順を維持 (= git worktree list の順)
3. `+ New worktree` ボタン

state による並び替えは行わない。Claude 起動 / 状態遷移でカード位置が動くと
「どこに何があるか」を覚えていられないため、位置は静的に保ち、状態は state
アイコンで識別する。

## 操作

- header 全体クリック: 折りたたみトグル (永続)。編集モード中は無効
- 編集モード時のみ ✕ 表示 + drag handle 有効。✕ クリックで window から repo を解除
</doc>

<script setup lang="ts">
import { useSortable } from "@dnd-kit/vue/sortable";
import type { Task, WorktreeEntry } from "@gozd/proto";
import { computed, useTemplateRef } from "vue";
import { useRepoStore } from "../../../../shared/repo";
import { WtCard } from "../worktree";

const props = defineProps<{
  rootDir: string;
  index: number;
  editMode: boolean;
  activeDir: string | undefined;
  isCreating: boolean;
  getResumeableSessionCount: (dir: string) => number;
  getFocusedPtyId: (dir: string) => number | undefined;
}>();

const emit = defineEmits<{
  removeRepo: [rootDir: string];
  selectWt: [wt: WorktreeEntry];
  selectTask: [wt: WorktreeEntry, task: Task];
  addWorktree: [rootDir: string];
  openWorktreeMenu: [anchorEl: HTMLElement, wt: WorktreeEntry, rootDir: string];
}>();

const repoStore = useRepoStore();

const repo = computed(() => repoStore.repos[props.rootDir]);
const repoName = computed(() => repo.value?.repoName ?? props.rootDir);
const isGitRepo = computed(() => repo.value?.isGitRepo ?? false);
const collapsed = computed(() => repoStore.isCollapsed(props.rootDir));

const worktrees = computed(() => repo.value?.worktrees ?? []);

/**
 * main wt 先頭固定、その他は repoStore の worktrees 配列順を維持。
 * Claude state による並び替えは行わない (位置の安定性を優先)。
 */
const orderedWorktrees = computed(() => {
  const all = worktrees.value;
  const main = all.find((wt) => wt.isMain);
  const others = all.filter((wt) => !wt.isMain);
  return main !== undefined ? [main, ...others] : others;
});

const isOwningActive = computed(() => {
  if (props.activeDir === undefined) return false;
  if (props.activeDir === props.rootDir) return true;
  return worktrees.value.some((wt) => wt.path === props.activeDir);
});

const sectionEl = useTemplateRef<HTMLElement>("section");
const dragHandleEl = useTemplateRef<HTMLElement>("dragHandle");

useSortable({
  id: computed(() => props.rootDir),
  index: computed(() => props.index),
  element: sectionEl,
  handle: dragHandleEl,
  disabled: computed(() => !props.editMode),
});

const visiblyCollapsed = computed(() => collapsed.value || props.editMode);

function onHeaderClick() {
  if (props.editMode) return;
  repoStore.toggleCollapsed(props.rootDir);
}
</script>

<template>
  <section ref="section" class="flex flex-col gap-2 rounded-lg p-2">
    <header
      class="group/repo flex items-center gap-2 rounded-lg"
      :class="[
        isOwningActive ? 'text-blue-300' : 'text-zinc-200',
        editMode ? '' : 'cursor-pointer hover:bg-white/5',
      ]"
      :role="editMode ? undefined : 'button'"
      :aria-label="editMode ? undefined : visiblyCollapsed ? 'Expand' : 'Collapse'"
      :aria-expanded="editMode ? undefined : !visiblyCollapsed"
      @click="onHeaderClick"
    >
      <div
        ref="dragHandle"
        class="flex min-w-0 flex-1 items-center gap-2"
        :class="editMode && 'cursor-grab active:cursor-grabbing'"
        :title="rootDir"
      >
        <span
          class="size-5 shrink-0"
          :class="visiblyCollapsed ? 'icon-[lucide--folder]' : 'icon-[lucide--folder-open]'"
        />
        <span class="min-w-0 flex-1 truncate text-sm font-semibold">
          {{ repoName }}
        </span>
      </div>
      <button
        v-if="editMode"
        type="button"
        aria-label="Remove repository from window"
        title="Remove from window"
        class="grid size-6 place-items-center rounded-sm text-red-400 hover:bg-red-500/20 hover:text-red-300"
        @click.stop="emit('removeRepo', rootDir)"
      >
        <span class="icon-[lucide--x] text-sm" />
      </button>
    </header>

    <div v-if="isGitRepo && !visiblyCollapsed" class="flex flex-col gap-1">
      <WtCard
        v-for="wt in orderedWorktrees"
        :key="wt.path"
        :wt="wt"
        :root-dir="rootDir"
        :active="activeDir === wt.path"
        :focused-pty-id="getFocusedPtyId(wt.path)"
        :resumeable-session-count="getResumeableSessionCount(wt.path)"
        @select-wt="emit('selectWt', $event)"
        @select-task="(w, t) => emit('selectTask', w, t)"
        @open-menu="(anchorEl, wt2) => emit('openWorktreeMenu', anchorEl, wt2, rootDir)"
      />
      <button
        type="button"
        class="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-zinc-700 px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:border-zinc-600 hover:bg-white/5 hover:text-zinc-300 disabled:opacity-50"
        :disabled="isCreating"
        @click="emit('addWorktree', rootDir)"
      >
        <span
          class="size-3.5"
          :class="isCreating ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--plus]'"
        />
        <span>New worktree</span>
      </button>
    </div>
  </section>
</template>
