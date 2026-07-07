<doc lang="md">
複数行文字列設定用テキストエリア。改行をそのまま保持する（stringArray と違い分割しない）。
StringWidget と同じく blur (@change) で確定し、per-keystroke の保存 RPC を避ける。
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
