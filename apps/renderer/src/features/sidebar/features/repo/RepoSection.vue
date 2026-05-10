<doc lang="md">
1 つの repo を表すサイドバーセクション。

ヘッダー（chevron + folder アイコン + repo 名 + 解除ボタン）と、
git repo であれば配下の ROOT / WORKTREES / BRANCHES を内側に展開する。

## 操作

- header 全体クリック: 折りたたみトグル（永続）。編集モードでは無効化
- 編集モード時のみ ✕ 表示 + drag handle 有効。✕ クリックで window から repo を解除（親で確認ダイアログ）

## 並び替え

`@dnd-kit/vue/sortable` の `useSortable` に委譲。`element` は `<section>`、
`handle` は内側の `<div ref="dragHandle">`。`disabled` を `!editMode` に紐付けて、
編集モード以外では drag を完全に無効化する。
</doc>

<script setup lang="ts">
import { useSortable } from "@dnd-kit/vue/sortable";
import type { WorktreeEntry } from "@gozd/proto";
import { computed, useTemplateRef } from "vue";
import { useRepoStore } from "../../../../shared/repo";
import type { ClaudeStatus } from "../../../terminal";
import { dirName } from "../../utils";
import { BranchList, RootWorktree, WorktreeList } from "../worktree";

const props = defineProps<{
  rootDir: string;
  index: number;
  /**
   * 編集モード。true の間は:
   * - 全 section が強制 collapse され、drag 並び替えが有効
   * - ✕ ボタンが常時表示され、削除可能
   * false の間は drag は無効、✕ は非表示、通常の折りたたみ操作のみ。
   */
  editMode: boolean;
  activeDir: string | undefined;
  isCreating: boolean;
  now: number;
  getClaudeStatuses: (dir: string) => ClaudeStatus[];
  /** 永続化されているが live PTY に未接続のセッション数（resume 可能件数） */
  getResumeableSessionCount: (dir: string) => number;
}>();

const emit = defineEmits<{
  removeRepo: [rootDir: string];
  selectRoot: [wt: WorktreeEntry];
  selectWorktree: [wt: WorktreeEntry];
  addWorktree: [rootDir: string];
  openWorktreeMenu: [anchorEl: HTMLElement, wt: WorktreeEntry, rootDir: string];
  openBranchMenu: [anchorEl: HTMLElement, branch: string, rootDir: string];
}>();

defineSlots<{
  "after-worktree-item"(props: { wt: WorktreeEntry; rootDir: string }): unknown;
}>();

const repoStore = useRepoStore();

const repo = computed(() => repoStore.repos[props.rootDir]);
const repoName = computed(() => repo.value?.repoName ?? props.rootDir);
const isGitRepo = computed(() => repo.value?.isGitRepo ?? false);
const collapsed = computed(() => repoStore.isCollapsed(props.rootDir));

const worktrees = computed(() => repo.value?.worktrees ?? []);
const rootWorktree = computed(() => worktrees.value.find((wt) => wt.isMain));
const nonMainWorktrees = computed(() =>
  worktrees.value
    .filter((wt) => !wt.isMain)
    .sort((a, b) => dirName(b.path).localeCompare(dirName(a.path))),
);
const sortedBranches = computed(() =>
  [...(repo.value?.freeBranches ?? [])].sort((a, b) => a.localeCompare(b)),
);

const isOwningActive = computed(() => {
  if (props.activeDir === undefined) return false;
  if (props.activeDir === props.rootDir) return true;
  return worktrees.value.some((wt) => wt.path === props.activeDir);
});

// --- 並び替え（@dnd-kit/vue） ---

const sectionEl = useTemplateRef<HTMLElement>("section");
const dragHandleEl = useTemplateRef<HTMLElement>("dragHandle");

useSortable({
  id: computed(() => props.rootDir),
  index: computed(() => props.index),
  element: sectionEl,
  // PointerSensor が handle 配下の click を preventDefault で潰すため、
  // chevron / ✕ ボタンは handle の外に出し、handle は folder + 名前部分だけにする
  handle: dragHandleEl,
  // 編集モード以外では drag を完全に無効化する
  disabled: computed(() => !props.editMode),
});

/**
 * 表示上の折りたたみ状態。
 * - 永続: header クリック（`collapsed`）
 * - 編集モード: 全 section を強制的に折りたたむ
 */
const visiblyCollapsed = computed(() => collapsed.value || props.editMode);

/**
 * header 全体クリックで折りたたみトグル。
 * 編集モードでは drag を優先するためトグルしない。
 */
function onHeaderClick() {
  if (props.editMode) return;
  repoStore.toggleCollapsed(props.rootDir);
}
</script>

<template>
  <section ref="section" class="border-b border-zinc-600 last:border-b-0">
    <header
      class="group/repo mb-2 flex items-center gap-1 rounded-sm px-1 py-1.5"
      :class="[
        isOwningActive ? 'bg-zinc-800/70' : 'hover:bg-zinc-800/40',
        editMode ? '' : 'cursor-pointer',
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
          class="size-4 shrink-0 text-zinc-400"
          :class="isGitRepo ? 'icon-[lucide--folder-git-2]' : 'icon-[lucide--folder]'"
        />
        <span class="min-w-0 flex-1 truncate text-base font-semibold text-zinc-100">
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

    <div v-if="isGitRepo && !visiblyCollapsed" class="pl-2">
      <RootWorktree
        :worktree="rootWorktree"
        :active="rootWorktree ? activeDir === rootWorktree.path : false"
        @select="emit('selectRoot', $event)"
      />

      <WorktreeList
        :worktrees="nonMainWorktrees"
        :loading="worktrees.length === 0"
        :active-dir="activeDir"
        :is-creating="isCreating"
        :now="now"
        :get-claude-statuses="getClaudeStatuses"
        :get-resumeable-session-count="getResumeableSessionCount"
        @select="emit('selectWorktree', $event)"
        @open-menu="(anchorEl, wt) => emit('openWorktreeMenu', anchorEl, wt, rootDir)"
        @add="emit('addWorktree', rootDir)"
      >
        <template #after-item="{ wt }">
          <slot name="after-worktree-item" :wt="wt" :root-dir="rootDir" />
        </template>
      </WorktreeList>

      <BranchList
        :branches="sortedBranches"
        @open-menu="(anchorEl, branch) => emit('openBranchMenu', anchorEl, branch, rootDir)"
      />
    </div>
  </section>
</template>
