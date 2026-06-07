<doc lang="md">
分割ツリーのリーフノード。XtermTerminal をラップし、フォーカス管理を行う。

## ヘッダバー

- 上部に CWD + ターミナルタイトル、Claude 状態バッジを配置
- worktree ディレクトリ外にいる場合は赤背景で警告表示

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
import type { ClaudeState } from "./claudeStatus";
import { CLAUDE_STATE_ICON } from "./claudeStatus";
import { currentTheme } from "./terminalConfig";
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

const claudeState = computed(() => terminalStore.getClaudeState(props.leafId));

const CLAUDE_STATE_LABEL: Record<ClaudeState, string> = {
  idle: "Idle",
  working: "Working",
  asking: "Ask",
  done: "Done",
};

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

/** OSC 0/2 で設定されたターミナルタイトル */
const title = computed(() => terminalStore.titleByLeafId[props.leafId]);

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
    <div
      class="relative size-full rounded-lg p-1 outline"
      :style="{ backgroundColor: currentTheme.background }"
      :class="
        isFocused
          ? 'outline-2 -outline-offset-4 outline-success'
          : '-outline-offset-2 outline-border'
      "
    >
      <!-- CWD + タイトル（左上、ボーダー線上） -->
      <div
        class="pointer-events-none absolute top-0 left-3 z-10 -translate-y-1/2 px-1 text-xs"
        :style="{ backgroundColor: currentTheme.background }"
        :class="isInsideWorktree ? 'text-foreground-low' : 'text-destructive-text'"
        :title="cwd"
      >
        {{ title ? `${cwdLabel} ${title}` : cwdLabel }}
      </div>
      <!-- Claude Code 状態インジケーター（右上、ボーダー線上） -->
      <div
        v-if="claudeState !== undefined"
        class="pointer-events-none absolute top-0 right-3 z-10 flex -translate-y-1/2 items-center gap-1 px-1 text-xs leading-none font-semibold"
        :style="{ backgroundColor: currentTheme.background }"
        :class="{
          'text-foreground-low': claudeState === 'idle',
          'text-warning-text': claudeState === 'working',
          'text-warning-strong-text': claudeState === 'asking',
          'text-success-text': claudeState === 'done',
        }"
      >
        <span
          class="size-3.5"
          :class="[CLAUDE_STATE_ICON[claudeState].icon, CLAUDE_STATE_ICON[claudeState].animate]"
        />
        <span>{{ CLAUDE_STATE_LABEL[claudeState] }}</span>
      </div>
      <!-- セッションログ preview（main / sub の最新 user / assistant 発言を右上に固定表示） -->
      <TerminalSessionPreview :leaf-id="leafId" />
      <div
        class="size-full overflow-hidden p-2 transition-opacity"
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
