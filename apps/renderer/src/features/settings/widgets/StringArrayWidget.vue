<doc lang="md">
文字列配列設定用テキストエリア。改行区切りで配列を編集する。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import type { StringArraySetting } from "../types";

const props = defineProps<{
  setting: StringArraySetting;
}>();

const model = defineModel<string[]>({ required: true });

const text = computed({
  get: () => model.value.join("\n"),
  set: (value: string) => {
    model.value = value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  },
});
</script>

<template>
  <textarea
    v-model="text"
    class="w-full resize-none rounded-sm border border-border-strong bg-surface-2 p-2 text-sm text-foreground-strong focus:ring-2 focus:ring-ring focus:outline-none"
    rows="4"
    :placeholder="props.setting.placeholder"
  />
</template>
