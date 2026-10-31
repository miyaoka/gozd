<script setup lang="ts">
import type { TextSetting } from "../types";

const props = defineProps<{
  setting: TextSetting;
}>();

const model = defineModel<string>({ required: true });
</script>

<template>
  <!-- 設定は変更のたびに保存されるため、打鍵ごと (v-model) ではなく確定 (change) で反映する -->
  <textarea
    :value="model"
    :placeholder="props.setting.placeholder"
    class="w-56 resize-none rounded-sm border border-border-strong bg-element p-2 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
    rows="4"
    @change="model = ($event.target as HTMLTextAreaElement).value"
  />
</template>
