<doc lang="md">
分割ツリーのリーフノード。XtermTerminal をラップし、フォーカス管理を行う。

## ヘッダバー

- 上部に CWD 表示 + Claude 状態バッジを配置
- CWD は OSC 7 でリアルタイム更新される（useTerminalStore.cwdByLeafId）
- worktree ディレクトリ外にいる場合は赤背景で警告表示

## フォーカス

- xterm の onFocus → store.focusPane() でフォーカス状態を更新
- store の focusedLeafId を watch し、自身が focused になったら imperative に terminal.focus()
</doc>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useContextKeys } from "../command/useContextKeys";
import { useTerminalStore } from "./useTerminalStore";
import XtermTerminal from "./XtermTerminal.vue";

interface Props {
  dir: string;
  leafId: string;
}

const props = defineProps<Props>();
const terminalStore = useTerminalStore();
const contextKeys = useContextKeys();

const xtermRef = ref<InstanceType<typeof XtermTerminal>>();

const isFocused = computed(() => {
  const layout = terminalStore.layoutsByDir[props.dir];
  if (layout === undefined) return false;
  return layout.focusedLeafId === props.leafId;
});

const effectiveFitSuspended = computed(() => terminalStore.dragSuspendCount > 0);

const claudeState = computed(() => terminalStore.getClaudeState(props.leafId));

const CLAUDE_STATE_LABEL: Record<string, string> = {
  working: "Working",
  asking: "Ask",
  done: "Done",
};

const claudeStateLabel = computed(() =>
  claudeState.value ? CLAUDE_STATE_LABEL[claudeState.value] : "Idle",
);

/** OSC 7 で通知された CWD。未取得時は worktree dir をフォールバック */
const cwd = computed(() => terminalStore.cwdByLeafId[props.leafId] ?? props.dir);

/** CWD が worktree ディレクトリ内にあるか */
const isInsideWorktree = computed(
  () => cwd.value === props.dir || cwd.value.startsWith(props.dir + "/"),
);

/** CWD を worktree dir の親からの相対パスで表示 */
const cwdLabel = computed(() => {
  if (!isInsideWorktree.value) return cwd.value;
  const parentEnd = props.dir.lastIndexOf("/");
  return cwd.value.slice(parentEnd + 1);
});

/**
 * store の focusedLeafId が自身を指しているなら imperative に DOM focus する。
 * immediate: true で mount 時の初期値も拾う（split 直後の新規 leaf 対応）。
 * flush: "post" で DOM 更新後に実行し、nextTick で child ref 確定を待つ。
 */
watch(
  isFocused,
  async (focused) => {
    if (!focused) return;
    await nextTick();
    xtermRef.value?.focus();
  },
  { immediate: true, flush: "post" },
);

function handleTerminalFocus() {
  contextKeys.set("terminalFocus", true);
  terminalStore.focusPane(props.leafId);
}

function handleTerminalBlur() {
  contextKeys.set("terminalFocus", false);
}
</script>

<template>
  <div class="size-full pt-2.5" :data-leaf-id="leafId">
    <div
      class="relative size-full rounded-lg border p-1"
      :class="isFocused ? 'border-green-300/50' : 'border-zinc-700'"
    >
      <!-- CWD（左上、ボーダー線上） -->
      <div
        class="pointer-events-none absolute top-0 left-3 z-10 -translate-y-1/2 bg-zinc-900 px-1 text-xs"
        :class="isInsideWorktree ? 'text-zinc-400' : 'text-red-300'"
      >
        <span :title="cwd">{{ cwdLabel }}</span>
      </div>
      <!-- Claude Code 状態インジケーター（右上、ボーダー線上） -->
      <div
        v-if="claudeState !== undefined"
        class="pointer-events-none absolute top-0 right-3 z-10 flex -translate-y-1/2 items-center gap-1 bg-zinc-900 px-1 text-xs leading-none font-semibold"
        :class="{
          'text-yellow-300': claudeState === 'working',
          'text-orange-300': claudeState === 'asking',
          'text-green-300': claudeState === 'done',
        }"
      >
        <span
          class="size-3.5"
          :class="{
            'icon-[lucide--loader] animate-spin': claudeState === 'working',
            'icon-[lucide--message-circle-warning]': claudeState === 'asking',
            'icon-[lucide--circle-check]': claudeState === 'done',
          }"
        />
        <span>{{ claudeStateLabel }}</span>
      </div>
      <XtermTerminal
        ref="xtermRef"
        class="size-full overflow-hidden"
        :dir="dir"
        :leaf-id="leafId"
        :fit-suspended="effectiveFitSuspended"
        @focus="handleTerminalFocus"
        @blur="handleTerminalBlur"
      />
    </div>
  </div>
</template>
