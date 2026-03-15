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
  fitSuspended?: boolean;
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

const effectiveFitSuspended = computed(
  () => props.fitSuspended === true || terminalStore.dragSuspendCount > 0,
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
    class="size-full overflow-hidden"
    :class="isFocused ? 'border border-blue-500/50' : 'border border-transparent'"
    :data-leaf-id="leafId"
  >
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
