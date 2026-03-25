<doc lang="md">
アプリ全体のレイアウトを構成するコンテナ。

## 構成

- 水平方向: SidebarPane → Terminal → Preview 開閉ボタン → NavigatorPane（各ペイン間にリサイズハンドル）
- 垂直方向: メインエリア → GitGraphPane（リサイズハンドル）
- Preview は Popover API でトップレイヤーに配置し、レイアウトフローから分離。Navigator の左側に表示

## リサイズ

各ハンドルは隣接する左右（上下）のペインだけを連動してリサイズする。
ハンドルより遠いペインには影響しない。
</doc>

<script setup lang="ts">
import { useWindowSize } from "@vueuse/core";
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch, watchEffect } from "vue";
import { useCommandRegistry, useContextKeys } from "../../shared/command";
import { QuickPick } from "../../shared/quick-pick";
import { useRpc } from "../../shared/rpc";
import { CommandPalette } from "../command-palette";
import { GitGraphPane } from "../git-graph";
import { NavigatorPane } from "../navigator";
import { PreviewPane } from "../preview";
import { registerSettingsCommand, SettingsModal } from "../settings";
import { SidebarPane } from "../sidebar";
import { registerThemeCommand, TerminalPane } from "../terminal";
import { useWorktreeStore } from "../worktree";
import ResizeHandle from "./ResizeHandle.vue";

const worktreeStore = useWorktreeStore();
const contextKeys = useContextKeys();
const previewPopoverRef = useTemplateRef<HTMLElement>("previewPopover");
const navigatorPaneRef = useTemplateRef<InstanceType<typeof NavigatorPane>>("navigatorPane");

// レイアウト・ウィンドウスコープのコマンド登録
const { register } = useCommandRegistry();
const { send } = useRpc();
const disposePreviewToggle = register("preview.toggle", {
  label: "Preview: Toggle",
  handler: () => {
    if (previewOpen.value) {
      closePreview();
    } else {
      openPreview();
    }
    return true;
  },
});
const disposeWindowClose = register("window.close", {
  label: "Window: Close",
  handler: () => {
    send.windowClose();
    return true;
  },
});
const disposeThemeCommand = registerThemeCommand();
const disposeSettingsCommand = registerSettingsCommand();
onUnmounted(disposePreviewToggle);
onUnmounted(disposeWindowClose);
onUnmounted(disposeThemeCommand);
onUnmounted(disposeSettingsCommand);

/** ハンドル幅 w-2 = 8px */
const HANDLE_WIDTH = 8;

const SIDEBAR_MIN_WIDTH = 120;
const PREVIEW_MIN_WIDTH = 200;
const TERMINAL_MIN_WIDTH = 200;
const NAVIGATOR_MIN_WIDTH = 180;
const GIT_GRAPH_MIN_HEIGHT = 40;
const MAIN_MIN_HEIGHT = 200;

const { width: windowWidth, height: windowHeight } = useWindowSize();

const sidebarWidth = ref(224);
const navigatorWidth = ref(256);
const previewWidth = ref(480);
const previewOpen = ref(false);
const mainHeight = ref(600);
const gitGraphHeight = ref(128);

/** Preview 開閉ボタンの固定幅（px-1 × 2 + size-4 + border-l） */
const PREVIEW_TOGGLE_WIDTH = 25;

/** Terminal 幅: ウィンドウ幅から Sidebar + H + Navigator + H + 開閉ボタンを引いた残余 */
const terminalWidth = computed(() =>
  Math.max(
    TERMINAL_MIN_WIDTH,
    windowWidth.value -
      sidebarWidth.value -
      HANDLE_WIDTH -
      navigatorWidth.value -
      HANDLE_WIDTH -
      PREVIEW_TOGGLE_WIDTH,
  ),
);

/** ドラッグ開始時の Terminal 幅（レイアウト計算値） */
const getTerminalWidth = () => terminalWidth.value;

/** Preview popover に許容される最大幅（Sidebar + H + Terminal 最小幅 + H を残す） */
const maxPreviewWidth = computed(
  () =>
    windowWidth.value -
    sidebarWidth.value -
    HANDLE_WIDTH -
    TERMINAL_MIN_WIDTH -
    HANDLE_WIDTH -
    navigatorWidth.value -
    PREVIEW_TOGGLE_WIDTH,
);

// ウィンドウ縮小時に Preview 幅をクランプ
watchEffect(() => {
  if (previewWidth.value > maxPreviewWidth.value) {
    previewWidth.value = Math.max(PREVIEW_MIN_WIDTH, maxPreviewWidth.value);
  }
});

/** ドラッグ開始時に popover 左側の空きスペースを返す（Navigator + 開閉ボタン分を除く） */
const getPreviewBeforeSize = () =>
  windowWidth.value - navigatorWidth.value - PREVIEW_TOGGLE_WIDTH - previewWidth.value;

/** ドラッグ開始時に Preview popover の DOM 実測幅を取得する */
const getPreviewAfterSize = () =>
  previewPopoverRef.value?.getBoundingClientRect().width ?? previewWidth.value;

// previewVisible context key を実際の表示状態と同期
watchEffect(() => {
  contextKeys.set("previewVisible", previewOpen.value);
});

/** :popover-open でガードして二重呼び出し例外を防止 */
function openPreview() {
  const el = previewPopoverRef.value;
  if (!el || el.matches(":popover-open")) return;
  el.showPopover();
}

function closePreview() {
  const el = previewPopoverRef.value;
  if (!el || !el.matches(":popover-open")) return;
  el.hidePopover();
}

/** popover の toggle イベントで previewOpen ref と同期 */
function onPreviewToggle(e: ToggleEvent) {
  previewOpen.value = e.newState === "open";
}

// ファイル選択時に Preview を自動オープンし、ツリーを対象パスまで展開する
watch(
  () => worktreeStore.selectedPath,
  async (path) => {
    if (!path) return;
    openPreview();
    await nextTick();
    void navigatorPaneRef.value?.reveal(path);
  },
);

// gozdOpen で同一パスが指定された場合にも Preview を開いてツリーを展開する
watch(
  () => worktreeStore.revealVersion,
  async () => {
    const path = worktreeStore.selectedPath;
    if (!path) return;
    openPreview();
    await nextTick();
    void navigatorPaneRef.value?.reveal(path);
  },
);

watchEffect(() => {
  const usedHeight = gitGraphHeight.value + HANDLE_WIDTH;
  mainHeight.value = Math.max(MAIN_MIN_HEIGHT, windowHeight.value - usedHeight);
});
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-zinc-900 text-white">
    <div class="flex shrink-0 overflow-hidden" :style="{ height: `${mainHeight}px` }">
      <div class="shrink-0 overflow-hidden" :style="{ width: `${sidebarWidth}px` }">
        <SidebarPane />
      </div>
      <ResizeHandle
        v-model:before-size="sidebarWidth"
        direction="horizontal"
        :before-min-size="SIDEBAR_MIN_WIDTH"
        :after-min-size="TERMINAL_MIN_WIDTH"
        :get-after-size="getTerminalWidth"
      />

      <TerminalPane :min-width="TERMINAL_MIN_WIDTH" />

      <ResizeHandle
        v-model:after-size="navigatorWidth"
        direction="horizontal"
        :before-min-size="TERMINAL_MIN_WIDTH"
        :after-min-size="NAVIGATOR_MIN_WIDTH"
        :get-before-size="getTerminalWidth"
      />

      <!-- Preview 開閉ボタン（Preview popover のアンカー） -->
      <button
        type="button"
        class="_preview-anchor flex shrink-0 items-center justify-center border-l border-zinc-700 px-1 text-zinc-500 hover:text-zinc-300"
        title="Toggle preview"
        aria-label="Toggle preview"
        @click="previewOpen ? closePreview() : openPreview()"
      >
        <span class="icon-[lucide--panel-right-open] size-4" />
      </button>

      <div class="shrink-0 overflow-hidden" :style="{ width: `${navigatorWidth}px` }">
        <NavigatorPane ref="navigatorPane" />
      </div>
    </div>

    <ResizeHandle
      v-model:before-size="mainHeight"
      v-model:after-size="gitGraphHeight"
      direction="vertical"
      :before-min-size="MAIN_MIN_HEIGHT"
      :after-min-size="GIT_GRAPH_MIN_HEIGHT"
    />
    <div class="shrink-0 overflow-hidden" :style="{ height: `${gitGraphHeight}px` }">
      <GitGraphPane />
    </div>

    <!-- Preview popover: 開閉ボタンをアンカーにして左側に展開 -->
    <div
      ref="previewPopover"
      popover="auto"
      class="_preview-popover overflow-hidden border-0 border-l border-zinc-700 bg-zinc-900 p-0 [&:popover-open]:flex"
      :style="{ width: `${previewWidth}px` }"
      @toggle="onPreviewToggle"
    >
      <!-- 左端リサイズハンドル -->
      <ResizeHandle
        v-model:after-size="previewWidth"
        direction="horizontal"
        :before-min-size="SIDEBAR_MIN_WIDTH + HANDLE_WIDTH + TERMINAL_MIN_WIDTH + HANDLE_WIDTH"
        :after-min-size="PREVIEW_MIN_WIDTH"
        :get-before-size="getPreviewBeforeSize"
        :get-after-size="getPreviewAfterSize"
      />

      <div class="min-w-0 flex-1 overflow-hidden">
        <PreviewPane @close="closePreview" />
      </div>
    </div>

    <CommandPalette />
    <QuickPick />
    <SettingsModal />
  </div>
</template>

<style>
._preview-anchor {
  anchor-name: --preview-anchor;
}

._preview-popover {
  /* アンカーの左端に右端を揃え、上下は viewport いっぱい */
  position-anchor: --preview-anchor;
  inset: unset;
  margin: 0;
  top: 0;
  bottom: 0;
  right: anchor(left);
  height: 100dvh;
  max-height: none;
}

._preview-popover::backdrop {
  background-color: rgb(0 0 0 / 0.3);
}
</style>
