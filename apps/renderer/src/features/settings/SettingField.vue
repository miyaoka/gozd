<doc lang="md">
個別の設定項目。widget 種別に応じて適切なウィジェットコンポーネントを描画する。
</doc>

<script setup lang="ts">
import type { SettingDefinition } from "./types";
import BooleanWidget from "./widgets/BooleanWidget.vue";
import EnumWidget from "./widgets/EnumWidget.vue";
import NumberWidget from "./widgets/NumberWidget.vue";
import StringArrayWidget from "./widgets/StringArrayWidget.vue";
import StringWidget from "./widgets/StringWidget.vue";
import VoicevoxSpeakerWidget from "./widgets/VoicevoxSpeakerWidget.vue";

defineProps<{
  setting: SettingDefinition;
}>();

// voicevoxSpeaker widget は store と直結するため v-model 経路を通らず、
// SettingSection から undefined が渡される。required: true だと契約違反になるため緩める
const model = defineModel<unknown>();
</script>

<template>
  <div class="flex items-start justify-between gap-4 py-2">
    <div class="min-w-0 flex-1">
      <div class="text-sm text-foreground-strong">{{ setting.label }}</div>
      <div v-if="setting.description" class="mt-0.5 text-xs text-foreground-subtle">
        {{ setting.description }}
      </div>
    </div>
    <div class="shrink-0">
      <BooleanWidget
        v-if="setting.widget === 'boolean'"
        v-model="model as boolean"
        :setting="setting"
      />
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
      <StringWidget
        v-else-if="setting.widget === 'string'"
        v-model="model as string"
        :setting="setting"
      />
      <StringArrayWidget
        v-else-if="setting.widget === 'stringArray'"
        v-model="model as string[]"
        :setting="setting"
      />
      <VoicevoxSpeakerWidget v-else-if="setting.widget === 'voicevoxSpeaker'" :setting="setting" />
    </div>
  </div>
</template>
