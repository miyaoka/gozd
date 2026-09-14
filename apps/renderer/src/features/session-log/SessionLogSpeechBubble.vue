<doc lang="md">
session log dialog の発言 1 件の吹き出し行。発言イベントと質問ツールの質問 / 回答が共有する。
</doc>

<script setup lang="ts">
import SessionLogMessageBody from "./SessionLogMessageBody.vue";
import SessionLogSpeakerRow from "./SessionLogSpeakerRow.vue";
import { SPEAKER_SURFACE_CLASS, type Speech } from "./sessionLogView";

defineProps<{
  speech: Speech;
}>();

const emit = defineEmits<{
  linkClick: [href: string];
  rendered: [];
}>();
</script>

<template>
  <SessionLogSpeakerRow :speaker="speech.speaker" :ts="speech.ts">
    <div class="min-w-0 rounded-2xl text-sm" :class="SPEAKER_SURFACE_CLASS[speech.speaker]">
      <SessionLogMessageBody
        :text="speech.text"
        :mark="speech.mark"
        @link-click="emit('linkClick', $event)"
        @rendered="emit('rendered')"
      />
    </div>
  </SessionLogSpeakerRow>
</template>
