<doc lang="md">
File picker の 1 行。ファイル名を主、親ディレクトリを従（低コントラスト）で表示する。
パス全体を等価に並べるより、ファイル名を視覚的な主キーにする方が候補の走査が速い
（VS Code Quick Open と同じ表示構造）。
</doc>

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
