<doc lang="md">
複数行文字列設定用テキストエリア。改行を含む 1 つの文字列として扱い、行に分割しない。

入力の確定はフォーカスが外れた時点で行う（単行入力と同じ理由）。
</doc>

<script setup lang="ts">
import type { TextSetting } from "../types";

const props = defineProps<{
  setting: TextSetting;
}>();

const model = defineModel<string>({ required: true });
</script>

<template>
  <textarea
    :value="model"
    :placeholder="props.setting.placeholder"
    class="w-56 resize-none rounded-sm border border-border-strong bg-element p-2 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
    rows="4"
    @change="model = ($event.target as HTMLTextAreaElement).value"
  />
</template>
