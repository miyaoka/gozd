<doc lang="md">
PR picker の1行分。PR 番号・タイトル・ブランチ・author・更新日時を色分け表示する。
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/proto";
import { computed } from "vue";
import { formatRelativeDate } from "../../formatRelativeDate";

const props = defineProps<{
  pr: GitPullRequest;
}>();

const dateDisplay = computed(() => formatRelativeDate(props.pr.updatedAt));
</script>

<template>
  <span class="truncate text-green-400">#{{ pr.number }}</span>
  <span class="truncate">{{ pr.title }}</span>
  <span class="truncate text-cyan-400">{{ pr.headRef }}</span>
  <span class="flex items-center gap-1 truncate text-zinc-400">
    <img
      v-if="pr.authorAvatarUrl !== ''"
      :src="pr.authorAvatarUrl"
      :alt="pr.author"
      class="size-5 shrink-0 rounded-full"
    />
    <span v-else class="icon-[lucide--user] size-5 shrink-0" />
    <span class="truncate">{{ pr.author }}</span>
  </span>
  <span class="truncate text-right" :class="dateDisplay.color">{{ dateDisplay.text }}</span>
</template>
