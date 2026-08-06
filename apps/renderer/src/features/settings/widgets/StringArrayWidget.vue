<doc lang="md">
文字列配列設定用テキストエリア。1 行を 1 要素として編集する。

前後の空白と空行は要素にしない。編集中に生まれる空行や、貼り付けに紛れた字下げがそのまま
設定値になると、見た目には無いはずの要素が保存される。
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
    class="w-full resize-none rounded-sm border border-border-strong bg-element p-2 text-sm text-foreground focus:border-primary focus:outline-none"
    rows="4"
    :placeholder="props.setting.placeholder"
  />
</template>
