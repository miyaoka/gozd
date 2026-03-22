<doc lang="md">
アプリ全体のレイアウトを構成するコンテナ。

## 構成

- 水平方向: SidebarPane → ターミナル Grid コンテナ（各ペイン間にリサイズハンドル）
- 垂直方向: メインエリア → DebugPane（リサイズハンドル）
- Explorer（FilerPane + PreviewPane）は Popover API でトップレイヤーに配置し、レイアウトフローから分離

## リサイズ

各ハンドルは隣接する左右（上下）のペインだけを連動してリサイズする。
ハンドルより遠いペインには影響しない。
</doc>

<script setup lang="ts">
import { useWindowSize } from "@vueuse/core";
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch, watchEffect } from "vue";
import { useCommandRegistry, useContextKeys } from "../../shared/command";
import { useRpc } from "../../shared/rpc";
import { DebugPane } from "../debug";
import { DiagnosticsPane } from "../diagnostics";
import { FilerPane } from "../filer";
import { PreviewPane } from "../preview";
import { SidebarPane } from "../sidebar";
import { TerminalPane } from "../terminal";
import { useWorktreeStore } from "../worktree";
import ResizeHandle from "./ResizeHandle.vue";

const worktreeStore = useWorktreeStore();
const contextKeys = useContextKeys();
const explorerPopoverRef = useTemplateRef<HTMLElement>("explorerPopover");
const filerPaneRef = useTemplateRef<InstanceType<typeof FilerPane>>("filerPane");

// レイアウト・ウィンドウスコープのコマンド登録
const { register } = useCommandRegistry();
const { send } = useRpc();
const disposeExplorerToggle = register("explorer.toggle", () => {
  if (explorerOpen.value) {
    closeExplorer();
  } else {
    openExplorer();
  }
  return true;
});
const disposeWindowClose = register("window.close", () => {
  send.windowClose();
  return true;
});
onUnmounted(disposeExplorerToggle);
onUnmounted(disposeWindowClose);

/** ハンドル幅 w-2 = 8px */
const HANDLE_WIDTH = 8;

const SIDEBAR_MIN_WIDTH = 120;
const FILER_MIN_WIDTH = 160;
const PREVIEW_MIN_WIDTH = 200;
const TERMINAL_MIN_WIDTH = 200;
/** Explorer popover の最小幅（H(left edge) + Filer + H(filer|preview) + Preview） */
const EXPLORER_MIN_WIDTH = HANDLE_WIDTH + FILER_MIN_WIDTH + HANDLE_WIDTH + PREVIEW_MIN_WIDTH;
const DEBUG_MIN_HEIGHT = 40;
const MAIN_MIN_HEIGHT = 200;

const { width: windowWidth, height: windowHeight } = useWindowSize();

const sidebarWidth = ref(224);
const filerWidth = ref(256);
/**
 * Explorer popover 全体の幅（H(left edge) + Filer + H(filer|preview) + Preview）。
 * 左端ハンドルのドラッグで set が呼ばれる。
 * Preview が最小幅に達したら Filer を縮めて Explorer 全体の縮小を継続する。
 */
const _explorerWidth = ref(672);
const explorerWidth = computed({
  get: () => _explorerWidth.value,
  set: (newWidth: number) => {
    _explorerWidth.value = newWidth;
    const preview = newWidth - HANDLE_WIDTH - filerWidth.value - HANDLE_WIDTH;
    if (preview < PREVIEW_MIN_WIDTH) {
      filerWidth.value = Math.max(
        FILER_MIN_WIDTH,
        newWidth - HANDLE_WIDTH - PREVIEW_MIN_WIDTH - HANDLE_WIDTH,
      );
    }
  },
});
const explorerOpen = ref(false);
const mainHeight = ref(600);
const debugHeight = ref(128);

/** Explorer 開閉ボタンの固定幅（px-1 × 2 + size-4 + border-l） */
const EXPLORER_TOGGLE_WIDTH = 25;

/** Preview に実際に割り当たる幅（Explorer 幅から Filer・ハンドルを引いた残り） */
const previewWidth = computed(
  () => explorerWidth.value - HANDLE_WIDTH - filerWidth.value - HANDLE_WIDTH,
);

/** Terminal 幅: ウィンドウ幅から Sidebar + H(sidebar|terminal) + 開閉ボタンを引いた残余 */
const terminalWidth = computed(() =>
  Math.max(
    TERMINAL_MIN_WIDTH,
    windowWidth.value - sidebarWidth.value - HANDLE_WIDTH - EXPLORER_TOGGLE_WIDTH,
  ),
);

/** ドラッグ開始時の Terminal 幅（レイアウト計算値） */
const getTerminalWidth = () => terminalWidth.value;

/** ドラッグ開始時に popover 左側の空きスペースを返す（Explorer 最大幅の制約に使用） */
const getExplorerBeforeSize = () => windowWidth.value - explorerWidth.value;

/** ドラッグ開始時に Explorer popover の DOM 実測幅を取得する */
const getExplorerAfterSize = () =>
  explorerPopoverRef.value?.getBoundingClientRect().width ?? explorerWidth.value;

/** ドラッグ開始時に Preview の実効幅を取得する */
const getPreviewSize = () => previewWidth.value;

// explorerVisible context key を実際の表示状態と同期
watchEffect(() => {
  contextKeys.set("explorerVisible", explorerOpen.value);
});

/** :popover-open でガードして二重呼び出し例外を防止 */
function openExplorer() {
  const el = explorerPopoverRef.value;
  if (!el || el.matches(":popover-open")) return;
  el.showPopover();
}

function closeExplorer() {
  const el = explorerPopoverRef.value;
  if (!el || !el.matches(":popover-open")) return;
  el.hidePopover();
}

/** popover の toggle イベントで explorerOpen ref と同期 */
function onExplorerToggle(e: ToggleEvent) {
  explorerOpen.value = e.newState === "open";
}

// ファイル選択時に Explorer を自動オープンし、ツリーを対象パスまで展開する
watch(
  () => worktreeStore.selectedPath,
  async (path) => {
    if (!path) return;
    openExplorer();
    await nextTick();
    void filerPaneRef.value?.reveal(path);
  },
);

// gozdOpen で同一パスが指定された場合にも explorer を開いてツリーを展開する
watch(
  () => worktreeStore.revealVersion,
  async () => {
    const path = worktreeStore.selectedPath;
    if (!path) return;
    openExplorer();
    await nextTick();
    void filerPaneRef.value?.reveal(path);
  },
);

watchEffect(() => {
  const usedHeight = debugHeight.value + HANDLE_WIDTH;
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

      <!-- Explorer 開閉ボタン（開く専用。閉じるのは light dismiss または popover 内の close） -->
      <button
        type="button"
        class="flex shrink-0 items-center justify-center border-l border-zinc-700 px-1 text-zinc-500 hover:text-zinc-300"
        title="Open explorer"
        aria-label="Open explorer"
        @click="openExplorer"
      >
        <span class="icon-[lucide--panel-right-open] size-4" />
      </button>
    </div>

    <ResizeHandle
      v-model:before-size="mainHeight"
      v-model:after-size="debugHeight"
      direction="vertical"
      :before-min-size="MAIN_MIN_HEIGHT"
      :after-min-size="DEBUG_MIN_HEIGHT"
    />
    <div class="flex shrink-0 gap-2 overflow-hidden p-0" :style="{ height: `${debugHeight}px` }">
      <div class="w-1/2 overflow-hidden">
        <DebugPane
          :explorer-open="explorerOpen"
          :layout-debug="{
            terminalWidth,
            explorerWidth,
            previewWidth,
            windowWidth,
          }"
        />
      </div>
      <div class="w-1/2 overflow-hidden">
        <DiagnosticsPane />
      </div>
    </div>

    <!-- Explorer popover: トップレイヤーに配置し、レイアウトフローから分離 -->
    <div
      ref="explorerPopover"
      popover="auto"
      class="_explorer-popover m-0 my-0 mr-0 ml-auto h-dvh max-h-none overflow-hidden border-0 border-l border-zinc-700 bg-zinc-900 p-0 [&:popover-open]:flex"
      :style="{ width: `${explorerWidth}px`, maxWidth: '100vw' }"
      @toggle="onExplorerToggle"
    >
      <!-- 左端リサイズハンドル（Explorer 全体の幅をドラッグで変更） -->
      <ResizeHandle
        v-model:after-size="explorerWidth"
        direction="horizontal"
        :before-min-size="SIDEBAR_MIN_WIDTH + HANDLE_WIDTH + TERMINAL_MIN_WIDTH"
        :after-min-size="EXPLORER_MIN_WIDTH"
        :get-before-size="getExplorerBeforeSize"
        :get-after-size="getExplorerAfterSize"
      />

      <div class="shrink-0 overflow-hidden" :style="{ width: `${filerWidth}px` }">
        <FilerPane ref="filerPane" />
      </div>

      <ResizeHandle
        v-model:before-size="filerWidth"
        direction="horizontal"
        :before-min-size="FILER_MIN_WIDTH"
        :after-min-size="PREVIEW_MIN_WIDTH"
        :get-after-size="getPreviewSize"
      />

      <div class="min-w-0 flex-1 overflow-hidden">
        <PreviewPane @close="closeExplorer" />
      </div>
    </div>
  </div>
</template>

<style>
._explorer-popover::backdrop {
  background-color: rgb(0 0 0 / 0.3);
}
</style>
