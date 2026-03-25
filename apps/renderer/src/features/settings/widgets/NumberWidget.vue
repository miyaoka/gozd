<doc lang="md">
number 設定用スライダー + 数値表示。
</doc>

<script setup lang="ts">
import type { NumberSetting } from "../types";

const props = defineProps<{
  setting: NumberSetting;
}>();

const model = defineModel<number>({ required: true });
</script>

<template>
  <div class="flex items-center gap-3">
    <input
      type="range"
      :aria-label="props.setting.label"
      class="h-1 w-40 cursor-pointer appearance-none rounded-full bg-zinc-700 accent-blue-500"
      :min="props.setting.min"
      :max="props.setting.max"
      :step="props.setting.step"
      :value="model"
      @input="model = Number(($event.target as HTMLInputElement).value)"
    />
    <span class="w-10 text-right text-xs text-zinc-400 tabular-nums">
      {{ model.toFixed(1) }}
    </span>
  </div>
</template>
