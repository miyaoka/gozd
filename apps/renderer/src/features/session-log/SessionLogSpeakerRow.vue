<script setup lang="ts">
import { computed } from "vue";
import SessionLogTimestamp from "./SessionLogTimestamp.vue";
import { SPEAKER_SIDE, type SpeechSpeaker } from "./sessionLogView";

const props = defineProps<{
  speaker: SpeechSpeaker;
  ts: string;
}>();

// 時刻は中身の外側に置くため、右寄せは並びごと反転する
const SIDE_ROW_CLASS = {
  left: "flex-row",
  right: "flex-row-reverse",
} as const satisfies Record<(typeof SPEAKER_SIDE)[SpeechSpeaker], string>;

const side = computed(() => SPEAKER_SIDE[props.speaker]);
</script>

<template>
  <div class="flex items-end gap-1.5" :class="SIDE_ROW_CLASS[side]">
    <slot />
    <SessionLogTimestamp :ts="ts" :align="side" />
  </div>
</template>
