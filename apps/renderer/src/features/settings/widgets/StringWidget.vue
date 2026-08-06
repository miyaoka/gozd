<doc lang="md">
文字列設定用テキスト入力。

入力の確定は打鍵ごとではなくフォーカスが外れた時点で行う。設定の変更はその都度保存されるため、
打鍵ごとに確定すると入力途中の文字列が保存され続ける。
</doc>

<script setup lang="ts">
import type { StringSetting } from "../types";

const props = defineProps<{
  setting: StringSetting;
}>();

const model = defineModel<string>({ required: true });
</script>

<template>
  <input
    type="text"
    :value="model"
    :placeholder="props.setting.placeholder"
    class="w-56 rounded-sm border border-border-strong bg-element px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none"
    @change="model = ($event.target as HTMLInputElement).value"
  />
</template>
