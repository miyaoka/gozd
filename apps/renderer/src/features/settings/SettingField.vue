<doc lang="md">
個別の設定項目。widget 種別に応じて適切なウィジェットコンポーネントを描画する。
</doc>

<script setup lang="ts">
import type { SettingDefinition } from "./types";
import BooleanWidget from "./widgets/BooleanWidget.vue";
import EnumWidget from "./widgets/EnumWidget.vue";
import NumberWidget from "./widgets/NumberWidget.vue";
import StringArrayWidget from "./widgets/StringArrayWidget.vue";

defineProps<{
  setting: SettingDefinition;
}>();

const model = defineModel<unknown>({ required: true });
</script>

<template>
  <div class="flex items-start justify-between gap-4 py-2">
    <div class="min-w-0 flex-1">
      <div class="text-sm text-zinc-200">{{ setting.label }}</div>
      <div v-if="setting.description" class="mt-0.5 text-xs text-zinc-500">
        {{ setting.description }}
      </div>
    </div>
    <div class="shrink-0">
      <BooleanWidget v-if="setting.widget === 'boolean'" v-model="model as boolean" />
      <NumberWidget
        v-else-if="setting.widget === 'number'"
        v-model="model as number"
        :setting="setting"
      />
      <EnumWidget
        v-else-if="setting.widget === 'enum'"
        v-model="model as string"
        :setting="setting"
      />
      <StringArrayWidget
        v-else-if="setting.widget === 'stringArray'"
        v-model="model as string[]"
        :setting="setting"
      />
    </div>
  </div>
</template>
