<doc lang="md">
1 task を表すサイドバーカード内の行。Claude state アイコン、タイトル、相対時刻、bubble を表示する。

## state アイコン

WCAG 1.4.1 準拠で色 + 形 + aria-label の 3 軸で状態を表現する。アニメーションは spin / pulse のみ
（bounce は notification spam に見えるため不採用）。`resumable` は live PTY 未接続の永続セッションを指す。

## 相対時刻の起点

`status.lastActivityAt`（Claude が最後に動いた時刻）を全 state で使う。state 遷移時刻ではなく
活動時刻を基準にすることで、working → idle / asking などで "now" にリセットされない。
status 不在（resumable）時は `task.createdAt` にフォールバックする。算出ロジックは
`taskBaseTime.resolveTaskBaseTime` を SSOT として使う。
</doc>

<script setup lang="ts">
import type { Task } from "@gozd/proto";
import { computed } from "vue";
import type { ClaudeStatus } from "../../../terminal";
import { extractAskingText, extractFirstSentence } from "../../../voicevox";
import { resolveTaskBaseTime } from "../../taskBaseTime";
import { useRelativeTime } from "../../useRelativeTime";
import { taskDisplayTitle } from "../../utils";

type StateKind = "asking" | "working" | "done" | "idle" | "resumable";

const STATE_VISUAL: Record<
  StateKind,
  { icon: string; color: string; animate?: string; ariaLabel: string }
> = {
  asking: {
    icon: "icon-[lucide--message-circle-warning]",
    color: "text-orange-400",
    animate: "animate-pulse",
    ariaLabel: "Awaiting permission",
  },
  working: {
    icon: "icon-[lucide--loader]",
    color: "text-yellow-400",
    animate: "animate-spin",
    ariaLabel: "Working",
  },
  done: {
    icon: "icon-[lucide--circle-check]",
    color: "text-green-400",
    ariaLabel: "Done",
  },
  idle: {
    icon: "icon-[lucide--circle-dot]",
    color: "text-zinc-500",
    ariaLabel: "Idle",
  },
  resumable: {
    icon: "icon-[lucide--rotate-cw]",
    color: "text-zinc-500/60",
    ariaLabel: "Resumable",
  },
};

const props = defineProps<{
  task: Task;
  status: ClaudeStatus | undefined;
  active: boolean;
}>();

const emit = defineEmits<{
  select: [task: Task];
}>();

const stateKind = computed<StateKind>(() => props.status?.state ?? "resumable");
const visual = computed(() => STATE_VISUAL[stateKind.value]);
const title = computed(() => taskDisplayTitle(props.task.body));

const baseTime = computed<number | undefined>(() => resolveTaskBaseTime(props.status, props.task));

const relativeTime = useRelativeTime(baseTime);

const bubbleText = computed<string | undefined>(() => {
  const status = props.status;
  if (status === undefined) return undefined;
  if (status.state === "done" && status.message) return extractFirstSentence(status.message);
  if (status.state === "asking") return extractAskingText(status.toolName, status.toolInput);
  return undefined;
});

const bubbleColorClass = computed(() => {
  const status = props.status;
  if (status?.state === "done") return "text-green-400/70";
  if (status?.state === "asking") return "text-orange-400/70";
  return "";
});
</script>

<template>
  <button
    type="button"
    :data-active="active"
    class="flex w-full items-center gap-2 rounded-lg p-2 text-left transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-hidden focus-visible:ring-inset data-[active=true]:bg-blue-500/30"
    @click="emit('select', task)"
  >
    <span
      class="size-5 shrink-0"
      :class="[visual.icon, visual.color, visual.animate]"
      role="img"
      :aria-label="visual.ariaLabel"
    />
    <span class="line-clamp-2 flex-1 text-sm break-all" :title="title">{{ title }}</span>
    <span class="text-[10px] tabular-nums opacity-70">{{ relativeTime }}</span>
  </button>
  <p
    v-if="bubbleText"
    class="line-clamp-1 text-xs italic"
    :class="bubbleColorClass"
    :title="bubbleText"
  >
    {{ bubbleText }}
  </p>
</template>
