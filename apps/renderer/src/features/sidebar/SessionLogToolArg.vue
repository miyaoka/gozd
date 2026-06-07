<doc lang="md">
session log の tool イベント見出しに出す主要引数プレビュー。算出ロジックは純関数
`toolArgPreview` (`sessionLogToolArg.ts`) に置き、ここは computed で 1 回呼んで描画するだけ。
preview が空なら何も描画しない。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { toolArgPreview } from "./sessionLogToolArg";

const props = defineProps<{
  input: Record<string, unknown>;
}>();

const preview = computed(() => toolArgPreview(props.input));
</script>

<template>
  <span v-if="preview" class="min-w-0 truncate text-foreground-low" :title="preview.full">{{
    preview.label
  }}</span>
</template>
