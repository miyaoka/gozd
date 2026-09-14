<doc lang="md">
セッションプレビュー (TerminalSessionPreview) で話者の側 (`SPEAKER_SIDE`) に寄せる行。発言の
吹き出しと進行中インジケータが共有し、話者から左右への対応を各行が持たない。
</doc>

<script setup lang="ts">
import { SPEAKER_SIDE, type SpeechSpeaker } from "../session-log";

defineProps<{
  speaker: SpeechSpeaker;
}>();

const SIDE_JUSTIFY_CLASS = {
  left: "justify-start",
  right: "justify-end",
} as const satisfies Record<(typeof SPEAKER_SIDE)[SpeechSpeaker], string>;
</script>

<template>
  <div class="flex min-w-0" :class="SIDE_JUSTIFY_CLASS[SPEAKER_SIDE[speaker]]">
    <slot />
  </div>
</template>
