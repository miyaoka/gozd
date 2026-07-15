<doc lang="md">
Issue picker の1行分。Issue 番号・タイトル・author・更新日時を色分け表示する。
`hasTask` (repo 内に同 issue の task が既に存在する) の行は番号横にチェックアイコンを出し、
選択が新規作成ではなく既存 task への切り替えになることを示す。
`creating` (accept 実行中) はチェックマークと同じ位置にスピナーを出す。実行中判定は
コマンド層所有の共有集合由来のため、picker を開き直しても実行中の間は表示が維持される。
</doc>

<script setup lang="ts">
import type { GitIssue } from "@gozd/rpc";
import { computed } from "vue";
import { formatRelativeDate } from "../../formatRelativeDate";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";
import IconLucideUser from "~icons/lucide/user";

const props = defineProps<{
  issue: GitIssue;
  hasTask: boolean;
  creating: boolean;
}>();

const dateDisplay = computed(() => formatRelativeDate(props.issue.updatedAt));
</script>

<template>
  <span class="flex items-center gap-1 text-success-text">
    <span class="truncate">#{{ issue.number }}</span>
    <template v-if="creating">
      <IconLucideLoaderCircle
        aria-hidden="true"
        class="size-3.5 shrink-0 animate-spin text-primary-text"
      />
      <span class="sr-only">creating task</span>
    </template>
    <template v-else-if="hasTask">
      <IconLucideCheck aria-hidden="true" class="size-3.5 shrink-0 text-primary-text" />
      <span class="sr-only">task exists</span>
    </template>
  </span>
  <span class="truncate">{{ issue.title }}</span>
  <span class="flex items-center gap-1 truncate text-foreground-low">
    <img
      v-if="issue.authorAvatarUrl !== ''"
      :src="issue.authorAvatarUrl"
      :alt="issue.author"
      class="size-5 shrink-0 rounded-full"
    />
    <IconLucideUser v-else class="size-5 shrink-0" />
    <span class="truncate">{{ issue.author }}</span>
  </span>
  <span class="truncate text-right" :class="dateDisplay.color">{{ dateDisplay.text }}</span>
</template>
