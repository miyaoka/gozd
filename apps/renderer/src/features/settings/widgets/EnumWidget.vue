<doc lang="md">
enum 設定用セレクトボックス。
options が関数の場合は呼び出して取得する。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import type { EnumSetting } from "../types";

const props = defineProps<{
  setting: EnumSetting;
}>();

const model = defineModel<string>({ required: true });

const options = computed(() =>
  typeof props.setting.options === "function" ? props.setting.options() : props.setting.options,
);
</script>

<template>
  <select
    :value="model"
    class="rounded-sm border border-zinc-600 bg-zinc-700 px-2 py-1 text-sm text-zinc-200 focus:border-blue-500 focus:outline-none"
    @change="model = ($event.target as HTMLSelectElement).value"
  >
    <option v-for="option in options" :key="option" :value="option">
      {{ option || "(Default)" }}
    </option>
  </select>
</template>
