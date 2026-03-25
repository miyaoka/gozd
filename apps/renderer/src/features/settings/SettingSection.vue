<doc lang="md">
設定セクション。タイトルと設定項目一覧を描画する。
</doc>

<script setup lang="ts">
import SettingField from "./SettingField.vue";
import type { SettingSection } from "./types";

defineProps<{
  section: SettingSection;
  values: Record<string, unknown>;
}>();

const emit = defineEmits<{
  change: [key: string, value: unknown];
}>();
</script>

<template>
  <div class="mb-4">
    <h3 class="mb-2 text-xs font-medium tracking-wider text-zinc-500 uppercase">
      {{ section.title }}
    </h3>
    <div class="divide-y divide-zinc-700/50">
      <SettingField
        v-for="(setting, key) in section.settings"
        :key="key"
        :setting="setting"
        :model-value="values[key] ?? setting.defaultValue"
        @update:model-value="emit('change', key as string, $event)"
      />
    </div>
  </div>
</template>
