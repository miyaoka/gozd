<doc lang="md">
PR picker の1行分。PR 番号・タイトル・ブランチ・author・更新日時を色分け表示する。
`hasTask` (repo 内に同 PR の task が既に存在する) の行は番号横にチェックアイコンを出し、
選択が新規作成ではなく既存 task への切り替えになることを示す。
`creating` (Shift 選択の accept 実行中) はチェックマークと同じ位置にスピナーを出す。
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/rpc";
import { computed } from "vue";
import { formatRelativeDate } from "../../formatRelativeDate";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";
import IconLucideUser from "~icons/lucide/user";

const props = defineProps<{
  pr: GitPullRequest;
  hasTask: boolean;
  creating: boolean;
}>();

const dateDisplay = computed(() => formatRelativeDate(props.pr.updatedAt));
</script>

<template>
  <span class="flex items-center gap-1 text-success-text">
    <span class="truncate">#{{ pr.number }}</span>
    <IconLucideLoaderCircle
      v-if="creating"
      aria-hidden="true"
      class="size-3.5 shrink-0 animate-spin text-primary-text"
    />
    <template v-else-if="hasTask">
      <IconLucideCheck aria-hidden="true" class="size-3.5 shrink-0 text-primary-text" />
      <span class="sr-only">task exists</span>
    </template>
  </span>
  <span class="truncate">{{ pr.title }}</span>
  <span class="truncate text-primary-text">{{ pr.headRef }}</span>
  <span class="flex items-center gap-1 truncate text-foreground-low">
    <img
      v-if="pr.authorAvatarUrl !== ''"
      :src="pr.authorAvatarUrl"
      :alt="pr.author"
      class="size-5 shrink-0 rounded-full"
    />
    <IconLucideUser v-else class="size-5 shrink-0" />
    <span class="truncate">{{ pr.author }}</span>
  </span>
  <span class="truncate text-right" :class="dateDisplay.color">{{ dateDisplay.text }}</span>
</template>
