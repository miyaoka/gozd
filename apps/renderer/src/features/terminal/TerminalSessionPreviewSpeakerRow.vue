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
