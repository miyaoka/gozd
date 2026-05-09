<doc lang="md">
1 つの repo を表すサイドバーセクション。

ヘッダー（folder アイコン + 編集可能な repo 名 + 削除ボタン）と、
git repo であれば配下の ROOT / WORKTREES / BRANCHES を内側に展開する。

非 git の dir は header のみを表示する（root として開ける）。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/proto";
import { computed } from "vue";
import { useRepoStore } from "../../../../shared/repo";
import type { ClaudeStatus } from "../../../terminal";
import { dirName } from "../../utils";
import { BranchList, RootWorktree, WorktreeList } from "../worktree";

type ViewMode = "wt" | "all" | "claude";

const props = defineProps<{
  rootDir: string;
  activeDir: string | undefined;
  isCreating: boolean;
  ctrlPressed: boolean;
  now: number;
  viewMode: ViewMode;
  getClaudeStatuses: (dir: string) => ClaudeStatus[];
}>();

const emit = defineEmits<{
  rename: [rootDir: string, name: string];
  removeRepo: [rootDir: string];
  selectRoot: [wt: WorktreeEntry];
  selectWorktree: [wt: WorktreeEntry];
  addWorktree: [rootDir: string];
  openWorktreeMenu: [anchorName: string, wt: WorktreeEntry, rootDir: string];
  openBranchMenu: [anchorName: string, branch: string, rootDir: string];
  setViewMode: [mode: ViewMode];
}>();

defineSlots<{
  "after-worktree-item"(props: { wt: WorktreeEntry; rootDir: string }): unknown;
}>();

const repoStore = useRepoStore();

const repo = computed(() => repoStore.repos[props.rootDir]);
const repoName = computed(() => repo.value?.repoName ?? props.rootDir);
const isGitRepo = computed(() => repo.value?.isGitRepo ?? false);

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

/** active dir をこの repo のどこか（root or worktree）に持っているか */
const isOwningActive = computed(() => {
  if (props.activeDir === undefined) return false;
  if (props.activeDir === props.rootDir) return true;
  return worktrees.value.some((wt) => wt.path === props.activeDir);
});
</script>

<template>
  <section class="mb-4">
    <header
      class="group/repo mb-2 flex items-center gap-2 rounded-sm px-2 py-1.5"
      :class="isOwningActive ? 'bg-zinc-800/70' : 'hover:bg-zinc-800/40'"
    >
      <span
        class="size-4 shrink-0 text-zinc-400"
        :class="isGitRepo ? 'icon-[lucide--folder-git-2]' : 'icon-[lucide--folder]'"
      />
      <input
        :value="repoName"
        :title="rootDir"
        aria-label="Repository name"
        class="min-w-0 flex-1 truncate bg-transparent text-base font-semibold text-zinc-100 outline-none"
        @input="emit('rename', rootDir, ($event.target as HTMLInputElement).value)"
      />
      <button
        type="button"
        aria-label="Remove repository from window"
        title="Remove from window"
        class="grid size-6 place-items-center rounded-sm text-zinc-500 opacity-0 transition-opacity group-focus-within/repo:opacity-100 group-hover/repo:opacity-100 hover:bg-zinc-700 hover:text-zinc-200"
        @click="emit('removeRepo', rootDir)"
      >
        <span class="icon-[lucide--x] text-sm" />
      </button>
    </header>

    <div v-if="isGitRepo" class="pl-2">
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
        :ctrl-pressed="ctrlPressed"
        :now="now"
        :view-mode="viewMode"
        :get-claude-statuses="getClaudeStatuses"
        @select="emit('selectWorktree', $event)"
        @open-menu="(anchorName, wt) => emit('openWorktreeMenu', anchorName, wt, rootDir)"
        @add="emit('addWorktree', rootDir)"
        @set-view-mode="emit('setViewMode', $event)"
      >
        <template #after-item="{ wt }">
          <slot name="after-worktree-item" :wt="wt" :root-dir="rootDir" />
        </template>
      </WorktreeList>

      <BranchList
        :branches="sortedBranches"
        @open-menu="(anchorName, branch) => emit('openBranchMenu', anchorName, branch, rootDir)"
      />
    </div>
  </section>
</template>
