<script setup lang="ts">
import { computed } from "vue";
import { SPEAKER_SURFACE_CLASS, toolArgPreview } from "../session-log";
import TerminalSessionPreviewSpeakerRow from "./TerminalSessionPreviewSpeakerRow.vue";

interface Props {
  count: number;
  /** 直近に呼ばれた tool。点の下に「今何をしているか」として出す */
  action: { name: string; input: Record<string, unknown> } | undefined;
}

const props = defineProps<Props>();

// 末尾 1 点は blink 用に別要素へ切り出すため、先頭側はまとめて 1 つのテキストにする
const leadingDots = computed(() => "・".repeat(Math.max(props.count - 1, 0)));

const actionArg = computed(() =>
  props.action === undefined ? undefined : toolArgPreview(props.action.input),
);
</script>

<template>
  <!-- アクションしているのはこのセッションのエージェントなので、その発言と同じ側・同じ地の吹き出し -->
  <TerminalSessionPreviewSpeakerRow v-if="count > 0" speaker="assistant" aria-hidden="true">
    <div
      class="flex max-w-[85%] min-w-0 flex-col rounded-lg px-2 py-1"
      :class="SPEAKER_SURFACE_CLASS.assistant"
    >
      <!-- 折り返しは wrap-anywhere に任せる。・ (U+30FB) は UAX #14 で直前の改行が禁止され、
           点の列が 1 語として吹き出しから溢れる。word-break: break-all では折り返せない -->
      <div class="wrap-anywhere">
        <span>{{ leadingDots }}</span
        ><span class="_fx-blink-dot">・</span>
      </div>
      <!-- コマンドやパターンは長く、折り返すと吹き出しが縦に伸びるため 1 行で切る -->
      <div v-if="action" class="truncate" :title="actionArg?.full">
        <span class="font-semibold">{{ action.name }}</span>
        <span v-if="actionArg" class="text-foreground-low"> {{ actionArg.label }}</span>
      </div>
    </div>
  </TerminalSessionPreviewSpeakerRow>
</template>
