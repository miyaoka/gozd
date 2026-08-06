<doc lang="md">
設定セクション。見出しと、その配下の設定項目を並べる。

**未設定の項目には定義の既定値を当てて描く**。保存された値は設定されたものだけを持つため、
そのまま渡すと初期状態の項目が空で描かれ、既定値が何かを画面から知る手段が無くなる。
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
    <h3 class="mb-2 text-xs font-medium tracking-wider text-foreground-low uppercase">
      {{ section.title }}
    </h3>
    <div class="divide-y divide-border-subtle">
      <SettingField
        v-for="(setting, key) in section.settings"
        :key="key"
        :setting="setting"
        :model-value="values[key] ?? ('defaultValue' in setting ? setting.defaultValue : undefined)"
        @update:model-value="emit('change', key as string, $event)"
      />
    </div>
  </div>
</template>
