<script setup lang="ts">
import type { TranscriptEvent } from "@gozd/claude-session-log";
import IconLucideGitBranch from "~icons/lucide/git-branch";

// rewind 分岐セレクタ: ここで会話が枝分かれした。番号は古い順 (最新が最大)。
// 選択中の枝をハイライトし、他をクリックでその枝へ切り替える。捨て枝が
// 存在することの可視化と、過去バージョンの閲覧を兼ねる。
defineProps<{
  event: Extract<TranscriptEvent, { kind: "branch" }>;
}>();

const emit = defineEmits<{
  // ts は選択枝先頭の時刻で、切替後にその分岐点へ寄せるのに使う。
  (e: "select", payload: { branchKey: string; childUuid: string; ts: string }): void;
}>();
</script>

<template>
  <div
    class="mx-auto flex w-fit max-w-[85%] scroll-mt-2 flex-wrap items-center justify-center gap-1.5 py-1 text-[11px] text-foreground-low"
  >
    <IconLucideGitBranch class="size-3.5 shrink-0" />
    <button
      v-for="opt in event.options"
      :key="opt.childUuid"
      type="button"
      class="flex max-w-[200px] items-center gap-1 rounded-full border px-2 py-0.5"
      :class="
        opt.childUuid === event.selectedChildUuid
          ? 'border-success bg-success-subtle text-success-text'
          : 'border-border text-foreground-low hover:bg-element-hover hover:text-foreground'
      "
      :title="opt.lead"
      @click="emit('select', { branchKey: event.branchKey, childUuid: opt.childUuid, ts: opt.ts })"
    >
      <span class="shrink-0 tabular-nums">#{{ opt.index }}</span>
      <span v-if="opt.lead !== ''" class="min-w-0 truncate">{{ opt.lead }}</span>
    </button>
  </div>
</template>
