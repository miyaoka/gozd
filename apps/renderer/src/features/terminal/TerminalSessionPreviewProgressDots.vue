<script setup lang="ts">
import { computed } from "vue";
import { SessionLogToolArg, SPEAKER_SURFACE_CLASS } from "../session-log";
import type { ToolEvent } from "./terminalSessionPreviewMessages";
import TerminalSessionPreviewSpeakerRow from "./TerminalSessionPreviewSpeakerRow.vue";

interface Props {
  /** 直近のターン境界以降に呼ばれた tool。件数が点の数、末尾が点の下に出す最後の tool */
  actions: ToolEvent[];
}

const props = defineProps<Props>();

// 末尾 1 点は blink 用に別要素へ切り出すため、先頭側はまとめて 1 つのテキストにする
const leadingDots = computed(() => "・".repeat(Math.max(props.actions.length - 1, 0)));
const latest = computed(() => props.actions.at(-1));
</script>

<template>
  <!-- アクションしているのはこのセッションのエージェントなので、その発言と同じ側・同じ地の吹き出し -->
  <TerminalSessionPreviewSpeakerRow v-if="latest" speaker="assistant">
    <div
      class="flex max-w-[85%] min-w-0 flex-col rounded-lg px-2 py-1"
      :class="SPEAKER_SURFACE_CLASS.assistant"
    >
      <!-- 折り返しは wrap-anywhere に任せる。・ (U+30FB) は UAX #14 で直前の改行が禁止され、
           点の列が 1 語として吹き出しから溢れる。word-break: break-all では折り返せない -->
      <div class="wrap-anywhere" aria-hidden="true">
        <span>{{ leadingDots }}</span
        ><span class="_fx-blink-dot">・</span>
      </div>
      <!-- コマンドやパターンは長く、折り返すと吹き出しが縦に伸びるため 1 行で切る -->
      <div class="flex min-w-0 gap-1">
        <!-- MCP の tool 名は吹き出しの幅を超えるため、名前も引数と同じく縮めて省略する -->
        <span class="min-w-0 truncate font-semibold">{{ latest.name }}</span>
        <SessionLogToolArg :input="latest.input" />
      </div>
    </div>
  </TerminalSessionPreviewSpeakerRow>
</template>
