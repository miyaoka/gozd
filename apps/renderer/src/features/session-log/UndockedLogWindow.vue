<script setup lang="ts">
import { UndockedWindow } from "../floating-window";
import { RepoIcon } from "../repo-icon";
import { WorktreeLabel } from "../worktree";
import SessionLogMessageBody from "./SessionLogMessageBody.vue";
import { SPEAKER_SURFACE_CLASS } from "./sessionLogView";
import { useUndockedLog, type UndockedLog } from "./useUndockedLog";

interface Props {
  log: UndockedLog;
}

const props = defineProps<Props>();
const { close, move, takeHandoff, promote, demote } = useUndockedLog();

// popover ヘッダのドラッグから undock された場合の引き継ぎ。setup で 1 回だけ消費する
// (undock() → 描画フラッシュ → setup が同期で完結するため、setup 時点で必ず取得できる)。
const handoff = takeHandoff(props.log.id);
</script>

<template>
  <UndockedWindow
    :x="log.x"
    :y="log.y"
    :content-width="log.contentWidth"
    :content-height="log.contentHeight"
    :child="log.child"
    :title="log.title"
    :block-close="false"
    :handoff="handoff"
    @move="(x, y) => move(log.id, x, y)"
    @promote="promote(log.id, $event)"
    @promote-failed="demote(log.id)"
    @close-requested="close(log.id)"
    @closed="close(log.id)"
  >
    <template #header>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div v-if="log.repoName !== ''" class="flex min-w-0 items-center gap-2">
          <RepoIcon :name="log.repoName" :owner="log.repoOwner" />
          <div class="flex min-w-0 flex-1 items-center overflow-hidden">
            <span class="min-w-0 truncate text-xs font-semibold tracking-wide">
              {{ log.repoName }}
            </span>
            <span v-if="log.worktree" class="max-w-full shrink-0 pl-2 text-xs text-foreground-low">
              <WorktreeLabel :wt="log.worktree" />
            </span>
          </div>
        </div>
        <h2 class="truncate text-xs text-foreground-low" :title="log.title">
          {{ log.title }}
        </h2>
      </div>
    </template>

    <div
      class="min-h-0 flex-1 overflow-auto select-text"
      :class="SPEAKER_SURFACE_CLASS[log.speaker]"
    >
      <SessionLogMessageBody :text="log.text" :mark="log.mark" />
    </div>
  </UndockedWindow>
</template>
