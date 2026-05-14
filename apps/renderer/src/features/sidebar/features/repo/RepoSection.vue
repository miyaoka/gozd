<doc lang="md">
1 つの repo を表すサイドバーセクション。

ヘッダ (chevron + folder アイコン + repo 名 + 編集モード時の ✕) と、
配下の WtCard 列 (main wt 先頭固定、その後 state 優先順) + `+ New worktree`。

## 並び順

1. main wt
2. その他 wt: 内側で最も優先度が高い task の state 順 (asking > working > done > idle > resumable)
3. `+ New worktree` ボタン

## 操作

- header 全体クリック: 折りたたみトグル (永続)。編集モード中は無効
- 編集モード時のみ ✕ 表示 + drag handle 有効。✕ クリックで window から repo を解除
</doc>

<script setup lang="ts">
import { useSortable } from "@dnd-kit/vue/sortable";
import type { Task, WorktreeEntry } from "@gozd/proto";
import { computed, useTemplateRef } from "vue";
import { useRepoStore } from "../../../../shared/repo";
import type { ClaudeStatus } from "../../../terminal";
import { WtCard } from "../worktree";

type StateKey = "asking" | "working" | "done" | "idle" | "resumable";
const STATE_PRIORITY: Record<StateKey, number> = {
  asking: 4,
  working: 3,
  done: 2,
  idle: 1,
  resumable: 0,
};

function statusToKey(status: ClaudeStatus | undefined): StateKey {
  if (status === undefined) return "resumable";
  return status.state;
}

const props = defineProps<{
  rootDir: string;
  index: number;
  editMode: boolean;
  activeDir: string | undefined;
  isCreating: boolean;
  now: number;
  getClaudeStatuses: (dir: string) => ClaudeStatus[];
  getResumeableSessionCount: (dir: string) => number;
  getTerminalCount: (dir: string) => number;
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

/** main wt 先頭固定、その他は内部最優先 status の優先度順 (時刻新しい順で同点解消) */
const orderedWorktrees = computed(() => {
  const all = [...worktrees.value];
  const main = all.find((wt) => wt.isMain);
  const others = all.filter((wt) => !wt.isMain);

  function topStateKey(wt: WorktreeEntry): StateKey {
    const statuses = props.getClaudeStatuses(wt.path);
    let best: StateKey = "resumable";
    let bestScore = -1;
    for (const status of statuses) {
      const key = statusToKey(status);
      const score = STATE_PRIORITY[key];
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
    return best;
  }

  others.sort((a, b) => {
    const diff = STATE_PRIORITY[topStateKey(b)] - STATE_PRIORITY[topStateKey(a)];
    if (diff !== 0) return diff;
    return a.path.localeCompare(b.path);
  });
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
  <section
    ref="section"
    :data-has-active="isOwningActive"
    class="rounded-lg p-1 data-[has-active=true]:bg-blue-500/8"
  >
    <header
      class="group/repo flex items-center gap-1 rounded-lg px-2 py-1.5"
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
          class="size-4 shrink-0"
          :class="isGitRepo ? 'icon-[lucide--folder-git-2]' : 'icon-[lucide--folder]'"
        />
        <span class="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide uppercase">
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

    <div v-if="isGitRepo && !visiblyCollapsed" class="mt-1 flex flex-col gap-1">
      <WtCard
        v-for="wt in orderedWorktrees"
        :key="wt.path"
        :wt="wt"
        :root-dir="rootDir"
        :active="activeDir === wt.path"
        :focused-pty-id="getFocusedPtyId(wt.path)"
        :terminal-count="getTerminalCount(wt.path)"
        :resumeable-session-count="getResumeableSessionCount(wt.path)"
        :now="now"
        @select-wt="emit('selectWt', $event)"
        @select-task="(w, t) => emit('selectTask', w, t)"
        @open-menu="(anchorEl, wt2) => emit('openWorktreeMenu', anchorEl, wt2, rootDir)"
      />
      <button
        type="button"
        class="grid w-full grid-cols-[auto_1fr] items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-500 hover:bg-white/5 disabled:opacity-50"
        :disabled="isCreating"
        @click="emit('addWorktree', rootDir)"
      >
        <span
          class="size-5"
          :class="isCreating ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--plus]'"
        />
        <span>New worktree</span>
      </button>
    </div>
  </section>
</template>
