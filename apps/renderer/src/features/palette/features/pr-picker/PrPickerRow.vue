<script setup lang="ts">
import type { GitPullRequest } from "@gozd/rpc";
import { computed } from "vue";
import { formatRelativeAge, isoToUnixSec } from "../../../../shared/time";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";
import IconLucideUser from "~icons/lucide/user";

const props = defineProps<{
  pr: GitPullRequest;
  creating: boolean;
}>();

const dateDisplay = computed(() => formatRelativeAge(isoToUnixSec(props.pr.updatedAt)));
</script>

<template>
  <span class="flex items-center gap-1 text-success-text">
    <span class="truncate">#{{ pr.number }}</span>
    <template v-if="creating">
      <IconLucideLoaderCircle
        aria-hidden="true"
        class="size-3.5 shrink-0 animate-spin text-primary-text"
      />
      <span class="sr-only">creating worktree</span>
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
