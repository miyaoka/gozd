<doc lang="md">
文字列設定用テキスト入力。
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
    class="w-56 rounded-sm border border-border-strong bg-surface-2 px-2 py-1 text-sm text-foreground-strong focus:ring-2 focus:ring-ring focus:outline-none"
    @change="model = ($event.target as HTMLInputElement).value"
  />
</template>
