<doc lang="md">
worktree の名前を描く。表し方 (branch 名、detached の印とディレクトリ名、bare、一覧を取得できない
repo の dir の印とディレクトリ名) の契約は docs/workspace.md の「各 worktree」。HEAD の hash を名前に
しないのは、同じ commit から作った worktree どうしで一致し commit で変わるため。

文字の色と大きさは置かれた面が決める。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/rpc";
import { computed } from "vue";
import { type RepoWorktree, worktreeLabel } from "../../shared/repo";
import IconLucideFolder from "~icons/lucide/folder";
import IconLucideGitCommitHorizontal from "~icons/lucide/git-commit-horizontal";

const props = defineProps<{
  wt: Pick<WorktreeEntry, "branch" | "path" | "head" | "detached"> &
    Pick<RepoWorktree, "listUnavailable">;
}>();

const label = computed(() => worktreeLabel(props.wt));

const LIST_UNAVAILABLE_TITLE = "Worktree list unavailable";

/** HEAD が未観測 (空文字) の間は tooltip を出さない */
const title = computed(() => {
  if (props.wt.listUnavailable === true) return LIST_UNAVAILABLE_TITLE;
  return props.wt.detached && props.wt.head !== ""
    ? `Detached HEAD at ${props.wt.head}`
    : undefined;
});
</script>

<template>
  <span class="flex min-w-0 items-center gap-1" :title="title">
    <IconLucideFolder
      v-if="wt.listUnavailable"
      class="size-3 shrink-0"
      role="img"
      :aria-label="LIST_UNAVAILABLE_TITLE"
    />
    <IconLucideGitCommitHorizontal
      v-else-if="wt.detached"
      class="size-3 shrink-0"
      role="img"
      aria-label="Detached HEAD"
    />
    <span class="truncate">{{ label }}</span>
  </span>
</template>
