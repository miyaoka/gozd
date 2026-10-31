<doc lang="md">
worktree の名前を描く。表し方 (branch 名、detached の印とディレクトリ名、bare) の契約は
docs/workspace.md の「各 worktree」。HEAD の hash を名前にしないのは、同じ commit から作った
worktree どうしで一致し commit で変わるため。

文字の色と大きさは置かれた面が決める。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/rpc";
import { computed } from "vue";
import { worktreeLabel } from "../../shared/repo";
import IconLucideGitCommitHorizontal from "~icons/lucide/git-commit-horizontal";

const props = defineProps<{
  wt: Pick<WorktreeEntry, "branch" | "path" | "head" | "detached">;
}>();

const label = computed(() => worktreeLabel(props.wt));

/** HEAD が未観測 (空文字) の間は tooltip を出さない */
const title = computed(() =>
  props.wt.detached && props.wt.head !== "" ? `Detached HEAD at ${props.wt.head}` : undefined,
);
</script>

<template>
  <span class="flex min-w-0 items-center gap-1" :title="title">
    <IconLucideGitCommitHorizontal
      v-if="wt.detached"
      class="size-3 shrink-0"
      role="img"
      aria-label="Detached HEAD"
    />
    <span class="truncate">{{ label }}</span>
  </span>
</template>
