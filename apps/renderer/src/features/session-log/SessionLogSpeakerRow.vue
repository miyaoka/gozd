<doc lang="md">
session log dialog で話者の側に寄せる行。話者の側 (`SPEAKER_SIDE`) に寄せ、時刻を中身の下端脇に
添える。発言の吹き出し・貼り付け画像・質問ツールの未回答の表示が共有し、話者から左右への対応を
各行が持たない。
</doc>

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
