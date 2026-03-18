<doc lang="md">
分割ツリーのリーフノード。XtermTerminal をラップし、フォーカス管理を行う。

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
  <div
    class="relative size-full overflow-hidden"
    :class="isFocused ? 'border border-blue-500/50' : 'border border-transparent'"
    :data-leaf-id="leafId"
  >
    <!-- Claude Code 状態インジケーター -->
    <div
      class="pointer-events-none absolute top-2 right-2 z-10 flex items-center gap-2 rounded-md px-3 py-1.5 text-sm leading-none font-semibold"
      :class="{
        'bg-yellow-950 text-yellow-300': claudeState === 'working',
        'bg-orange-950 text-orange-300': claudeState === 'asking',
        'bg-green-950 text-green-300': claudeState === 'done',
        'bg-zinc-800 text-zinc-400': claudeState === undefined,
      }"
    >
      <span
        class="size-5"
        :class="{
          'icon-[lucide--loader] animate-spin': claudeState === 'working',
          'icon-[lucide--message-circle-warning]': claudeState === 'asking',
          'icon-[lucide--circle-check]': claudeState === 'done',
          'icon-[lucide--circle-dashed]': claudeState === undefined,
        }"
      />
      <span>{{ claudeStateLabel }}</span>
    </div>
    <XtermTerminal
      ref="xtermRef"
      :dir="dir"
      :leaf-id="leafId"
      :fit-suspended="effectiveFitSuspended"
      @focus="handleTerminalFocus"
      @blur="handleTerminalBlur"
    />
  </div>
</template>
