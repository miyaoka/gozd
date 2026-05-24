<doc lang="md">
VOICEVOX キャラ・スタイル選択用 widget。
voicevox feature の VoicevoxSpeakerSelect を薄くラップする。

## 注意

実体は voicevox store に直接結合しているため、model は store 内 speakerId と二重管理にならないよう
ここでは defineModel を使わず、表示のみ store 経由で完結させる。
保存経路も store の watch 経由で AppConfig に書き込まれるため、settings の patch 経由は通らない。
</doc>

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
