<doc lang="md">
分割ツリーのリーフノード。XtermTerminal をラップし、フォーカス管理を行う。

## ヘッダバー

- Claude セッションが attach された leaf だけ、上部 (ボーダー線上) に status アイコン +
  task タイトルを表示する（`TerminalLeafTitle`）。素の PTY では何も出さない

## フォーカス

- xterm の onFocus → store.focusPane() でフォーカス状態を更新
- 自身が focused になったタイミングで子の terminal.focus() を呼ぶ責務は XtermTerminal に委譲し、isFocused を props として渡す
- focus 時に worktreeStore.setOpen() を呼んで選択を追従させる（viewMode は変更しない）
- 既読消化（done → idle）は useSidebarData が selectionVersion を watch して処理するため、ここでは setOpen を呼ぶだけでよい

## active 表示

- 選択中 worktree（worktreeStore.dir）配下かつ layout.focusedLeafId と一致する leaf のみ opacity-100
- それ以外は opacity-50 でフェード。claude タイルモードでは複数 worktree の leaf が同時表示されるが、active になるのは選択中 worktree の focused leaf 1 つだけ
- 初期化前で worktreeStore.dir が未確定の場合や、claude モードで選択中 worktree に Claude-active leaf が存在しない場合は active が 0 になりうる
</doc>

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
  // 同 dir でも setOpen を呼ぶことで selectionVersion が発火し、useTerminalStore の
  // watch が done を消化する。viewMode="claude" でも選択 wt が追従する。
  worktreeStore.setOpen(props.dir);
}

function handleTerminalBlur() {
  contextKeys.set("terminalFocus", false);
}
</script>

<template>
  <div class="min-h-0 min-w-0" :data-leaf-id="leafId">
    <!-- container-type: size は TerminalSessionPreview のスクロール面 (max-h-[40cqh]) が
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
      <!-- Claude セッションのみ: 2 行タイトル（上段 repo アイコン + repo 名 / 下段 status アイコン + task タイトル） -->
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
          @focus="handleTerminalFocus"
          @blur="handleTerminalBlur"
        />
      </div>
    </div>
  </div>
</template>
