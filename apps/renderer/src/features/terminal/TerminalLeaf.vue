<script setup lang="ts">
import { computed } from "vue";
import { useContextKeys } from "../../shared/command";
import { useWorktreeStore } from "../worktree";
import { currentTheme } from "./terminalConfig";
import TerminalLeafTitle from "./TerminalLeafTitle.vue";
import TerminalSessionPreview from "./TerminalSessionPreview.vue";
import { useTerminalStore } from "./useTerminalStore";
import XtermTerminal from "./XtermTerminal.vue";

interface Props {
  dir: string;
  leafId: string;
  /** 親の v-show による表示状態。XtermTerminal の WebglAddon ライフサイクル同期に使う */
  visible: boolean;
}

const props = defineProps<Props>();
const terminalStore = useTerminalStore();
const worktreeStore = useWorktreeStore();
const contextKeys = useContextKeys();

// claude タイルモードでは各 worktree が独立に focusedLeafId を持つため、
// 単純比較だと worktree ごとに 1 つずつ active 表示になってしまう。
// 選択中の worktree （worktreeStore.dir）配下の focusedLeafId だけを active と見なす。
const isFocused = computed(() => {
  if (worktreeStore.dir !== props.dir) return false;
  const layout = terminalStore.layoutsByDir[props.dir];
  if (layout === undefined) return false;
  return layout.focusedLeafId === props.leafId;
});

const effectiveFitSuspended = computed(() => terminalStore.dragSuspendCount > 0);

function handleTerminalFocus() {
  contextKeys.set("terminalFocus", true);
  terminalStore.focusPane(props.leafId);
  // 同 dir でも setOpen を呼ぶことで selectionVersion が発火し、useSidebarData の
  // watch が done を消化する。viewMode="claude" でも選択 wt が追従する。
  worktreeStore.setOpen(props.dir);
}

function handleTerminalBlur() {
  contextKeys.set("terminalFocus", false);
}
</script>

<template>
  <div class="min-h-0 min-w-0" :data-leaf-id="leafId">
    <!-- container-type: size は TerminalSessionPreview のスクロール面 (max-h-[calc(50cqh-2rem)]) が
         leaf 高さを参照するための query container 指定。size-full で寸法が親から確定して
         いるため size containment による高さ collapse は起きない -->
    <div
      class="@container-size relative flex size-full flex-col rounded-lg p-1 outline"
      :style="{ backgroundColor: currentTheme.background }"
      :class="
        isFocused
          ? 'outline-2 -outline-offset-4 outline-success'
          : '-outline-offset-2 outline-border'
      "
    >
      <!-- Claude セッションのみ: 2 行タイトル（上段 repo アイコン + repo 名 / 下段 status アイコン + セッションタイトル） -->
      <TerminalLeafTitle :dir="dir" :leaf-id="leafId" />
      <!-- セッションログ preview（main / sub の最新 user / assistant 発言を右上に固定表示。
           leaf 全体に対する absolute overlay なのでヘッダ行に被さってよい） -->
      <TerminalSessionPreview :leaf-id="leafId" />
      <div
        class="min-h-0 flex-1 overflow-hidden p-2 transition-opacity"
        :class="isFocused ? 'opacity-100' : 'opacity-50'"
      >
        <XtermTerminal
          class="size-full"
          :dir="dir"
          :leaf-id="leafId"
          :fit-suspended="effectiveFitSuspended"
          :focused="isFocused"
          :visible="visible"
          @focus="handleTerminalFocus"
          @blur="handleTerminalBlur"
        />
      </div>
    </div>
  </div>
</template>
