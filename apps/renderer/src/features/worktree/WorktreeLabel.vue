<doc lang="md">
worktree の表示名。branch を持つ worktree は branch 名だけを出す。

detached HEAD の worktree は branch を持たないため、ディレクトリ名を出して名前の前に commit icon を
添える。ディレクトリ名は branch 名と同じ字面で並ぶので、icon が無いと branch 名と読み違える。
HEAD の hash は同じ commit から作った worktree どうしで一致し commit で変わるため、名前にせず
hover で見せる。

文字の色と大きさは置かれた面が決める。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/rpc";
import { computed } from "vue";
import { isDetached, worktreeLabel } from "../../shared/repo";
import IconLucideGitCommitHorizontal from "~icons/lucide/git-commit-horizontal";

const props = defineProps<{
  wt: Pick<WorktreeEntry, "branch" | "path" | "head">;
}>();

const detached = computed(() => isDetached(props.wt.branch));

const label = computed(() => worktreeLabel(props.wt));

/** HEAD が未観測 (空文字) の間は tooltip を出さない */
const title = computed(() =>
  detached.value && props.wt.head !== "" ? `Detached HEAD at ${props.wt.head}` : undefined,
);
</script>

<template>
  <span class="flex min-w-0 items-center gap-1" :title="title">
    <IconLucideGitCommitHorizontal
      v-if="detached"
      class="size-3 shrink-0"
      role="img"
      aria-label="Detached HEAD"
    />
    <span class="truncate">{{ label }}</span>
  </span>
</template>
