<doc lang="md">
Issue picker の1行分。Issue 番号・タイトル・author・更新日時を色分け表示する。
</doc>

<script setup lang="ts">
import type { GitIssue } from "@gozd/proto";
import { computed } from "vue";
import { formatRelativeDate } from "../../formatRelativeDate";

const props = defineProps<{
  issue: GitIssue;
}>();

const dateDisplay = computed(() => formatRelativeDate(props.issue.updatedAt));
</script>

<template>
  <span class="truncate text-success">#{{ issue.number }}</span>
  <span class="truncate">{{ issue.title }}</span>
  <span class="flex items-center gap-1 truncate text-foreground-muted">
    <img
      v-if="issue.authorAvatarUrl !== ''"
      :src="issue.authorAvatarUrl"
      :alt="issue.author"
      class="size-5 shrink-0 rounded-full"
    />
    <span v-else class="icon-[lucide--user] size-5 shrink-0" />
    <span class="truncate">{{ issue.author }}</span>
  </span>
  <span class="truncate text-right" :class="dateDisplay.color">{{ dateDisplay.text }}</span>
</template>
