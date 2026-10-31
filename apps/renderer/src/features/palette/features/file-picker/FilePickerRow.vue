<script setup lang="ts">
import { computed } from "vue";
import { getFileIconUrl } from "../../../filer";

const props = defineProps<{ path: string }>();

const lastSlash = computed(() => props.path.lastIndexOf("/"));
const fileName = computed(() => props.path.slice(lastSlash.value + 1));
/** 親ディレクトリ。worktree root 直下は空文字 */
const dirPath = computed(() =>
  lastSlash.value === -1 ? "" : props.path.slice(0, lastSlash.value),
);
const iconUrl = computed(() => getFileIconUrl(fileName.value));
</script>

<template>
  <img :src="iconUrl" class="size-4 shrink-0" alt="" />
  <span class="shrink-0">{{ fileName }}</span>
  <span v-if="dirPath !== ''" class="truncate text-xs text-foreground-low">{{ dirPath }}</span>
</template>
