<script setup lang="ts">
import { VoicevoxSpeakerSelect } from "../../voicevox";
import type { VoicevoxSpeakerSetting } from "../types";

defineProps<{
  setting: VoicevoxSpeakerSetting;
}>();
</script>

<template>
  <VoicevoxSpeakerSelect />
</template>
