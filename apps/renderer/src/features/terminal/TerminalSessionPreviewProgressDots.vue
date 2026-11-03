<script setup lang="ts">
import { computed } from "vue";
import { SPEAKER_SURFACE_CLASS } from "../session-log";
import TerminalSessionPreviewSpeakerRow from "./TerminalSessionPreviewSpeakerRow.vue";

interface Props {
  count: number;
}

const props = defineProps<Props>();

// 末尾 1 点は blink 用に別要素へ切り出すため、先頭側はまとめて 1 つのテキストにする
const leadingDots = computed(() => "・".repeat(Math.max(props.count - 1, 0)));
</script>

<template>
  <!-- アクションしているのはこのセッションのエージェントなので、その発言と同じ側・同じ地の吹き出し -->
  <TerminalSessionPreviewSpeakerRow v-if="count > 0" speaker="assistant" aria-hidden="true">
    <!-- 折り返しは wrap-anywhere に任せる。・ (U+30FB) は UAX #14 で直前の改行が禁止され、
         点の列が 1 語として吹き出しから溢れる。word-break: break-all では折り返せない -->
    <div
      class="max-w-[85%] rounded-lg px-2 py-1 wrap-anywhere"
      :class="SPEAKER_SURFACE_CLASS.assistant"
    >
      <span>{{ leadingDots }}</span
      ><span class="_fx-blink-dot">・</span>
    </div>
  </TerminalSessionPreviewSpeakerRow>
</template>
