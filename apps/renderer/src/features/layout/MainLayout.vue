<doc lang="md">
アプリ全体のレイアウトを構成するコンテナ。

## 構成

- 水平方向: SidebarPane → TerminalPane → FilerPane → PreviewPane（各ペイン間にリサイズハンドル）
- 垂直方向: メインエリア → DebugPane（リサイズハンドル）
- FilerPane + PreviewPane は Explorer グループとして一体的に開閉する

## リサイズ

各ハンドルは隣接する左右（上下）のペインだけを連動してリサイズする。
ハンドルより遠いペインには影響しない。
</doc>

<script setup lang="ts">
import { useEventListener, useWindowSize } from "@vueuse/core";
import { computed, onUnmounted, ref, useTemplateRef, watch, watchEffect } from "vue";
import { useContextKeys } from "../command/useContextKeys";
import DebugPane from "../debug/DebugPane.vue";
import DiagnosticsPane from "../diagnostics/DiagnosticsPane.vue";
import FilerPane from "../filer/FilerPane.vue";
import { useWorkspaceStore } from "../filer/useWorkspaceStore";
import PreviewPane from "../preview/PreviewPane.vue";
import { registerTerminalCommands } from "../terminal/registerTerminalCommands";
import TerminalPane from "../terminal/TerminalPane.vue";
import { useTerminalStore } from "../terminal/useTerminalStore";
import ResizeHandle from "./ResizeHandle.vue";
import SidebarPane from "./SidebarPane.vue";

const workspaceStore = useWorkspaceStore();
const terminalStore = useTerminalStore();
const contextKeys = useContextKeys();
const terminalContainerRef = useTemplateRef<HTMLElement>("terminalContainer");
const explorerContainerRef = useTemplateRef<HTMLElement>("explorerContainer");

const currentDir = computed(() => workspaceStore.dir);
const disposeTerminalCommands = registerTerminalCommands(currentDir, terminalContainerRef);
onUnmounted(disposeTerminalCommands);

// ウィンドウの表示状態変更時に terminalFocus を同期
// hidden 時は false にリセット、復帰時は activeElement から再判定
// （WKWebView では復帰時に xterm の focus が再発火しない場合がある）
useEventListener(document, "visibilitychange", () => {
  if (document.hidden) {
    contextKeys.set("terminalFocus", false);
  } else {
    const container = terminalContainerRef.value;
    const active = document.activeElement;
    const isFocused = container !== null && active !== null && container.contains(active);
    contextKeys.set("terminalFocus", isFocused);
  }
});

// worktree を初めて訪問したときに visitedDirs に登録
// worktree 切り替え時に terminalFocus をリセット
watch(
  () => workspaceStore.dir,
  (dir) => {
    contextKeys.set("terminalFocus", false);
    if (dir) terminalStore.visit(dir);
  },
  { immediate: true },
);

const SIDEBAR_MIN_WIDTH = 120;
const FILER_MIN_WIDTH = 160;
const PREVIEW_MIN_WIDTH = 200;
const TERMINAL_MIN_WIDTH = 200;
/** Explorer グループ内部の最小幅（Filer + H(filer|preview) + Preview） */
const EXPLORER_MIN_WIDTH = FILER_MIN_WIDTH + 8 + PREVIEW_MIN_WIDTH;
const DEBUG_MIN_HEIGHT = 40;
const MAIN_MIN_HEIGHT = 200;

/** ハンドル幅 w-2 = 8px */
const HANDLE_WIDTH = 8;

const { width: windowWidth, height: windowHeight } = useWindowSize();

const sidebarWidth = ref(224);
const filerWidth = ref(256);
/** ユーザーが決めた希望幅 */
const previewWidth = ref(400);
const explorerOpen = ref(false);
const mainHeight = ref(600);
const debugHeight = ref(128);

/** Explorer 開閉ボタンの固定幅（px-1 × 2 + size-4 + border-l） */
const EXPLORER_TOGGLE_WIDTH = 25;

/** Terminal を最小幅にしたときに Preview に使える最大幅 */
const availablePreviewWidth = computed(() => {
  if (!explorerOpen.value) return 0;
  return Math.max(
    0,
    windowWidth.value -
      sidebarWidth.value -
      filerWidth.value -
      TERMINAL_MIN_WIDTH -
      HANDLE_WIDTH * 3,
  );
});

/** プレビューに実際に割り当てる幅（余白に収まるようクランプ） */
const dockedPreviewWidth = computed(() => {
  if (!explorerOpen.value) return 0;
  return Math.min(previewWidth.value, availablePreviewWidth.value);
});

/** Explorer グループ（Filer + Preview）を表示できるだけの余白があるか */
const canDockExplorer = computed(() => dockedPreviewWidth.value >= PREVIEW_MIN_WIDTH);

/**
 * Explorer グループ全体の幅（Filer + H(filer|preview) + Preview）。
 * Terminal-Explorer 間ハンドルのドラッグで set が呼ばれる。
 * Filer 幅は固定のまま、Preview が残り幅を吸収する。
 */
const explorerWidth = computed({
  get: () => filerWidth.value + HANDLE_WIDTH + dockedPreviewWidth.value,
  set: (newWidth: number) => {
    previewWidth.value = Math.max(PREVIEW_MIN_WIDTH, newWidth - HANDLE_WIDTH - filerWidth.value);
  },
});

/**
 * Explorer セクションが占める幅
 * ドック時: H(terminal|explorer) + Explorer グループ
 * 非ドック時: 開閉ボタンのみ
 */
const explorerSectionWidth = computed(() =>
  explorerOpen.value && canDockExplorer.value
    ? HANDLE_WIDTH + explorerWidth.value
    : EXPLORER_TOGGLE_WIDTH,
);

/** Terminal 幅: ウィンドウ幅から Sidebar + H(sidebar|terminal) + Explorer セクションを引いた残余 */
const terminalWidth = computed(() =>
  Math.max(
    TERMINAL_MIN_WIDTH,
    windowWidth.value - sidebarWidth.value - HANDLE_WIDTH - explorerSectionWidth.value,
  ),
);

/** ドラッグ開始時に Terminal の DOM 実測幅を取得する */
const getTerminalWidth = () =>
  terminalContainerRef.value?.getBoundingClientRect().width ?? terminalWidth.value;

/** ドラッグ開始時に Explorer グループの DOM 実測幅を取得する */
const getExplorerWidth = () =>
  explorerContainerRef.value?.getBoundingClientRect().width ?? explorerWidth.value;

/** デバッグ用 */
const leftFixedWidth = computed(() => sidebarWidth.value + HANDLE_WIDTH + terminalWidth.value);
const rightFreeWidth = computed(() => Math.max(0, windowWidth.value - leftFixedWidth.value));

// explorerVisible context key を実際の表示状態と同期
watchEffect(() => {
  contextKeys.set("explorerVisible", explorerOpen.value && canDockExplorer.value);
});

/** Explorer 開閉の過渡期に xterm の自動 fit を抑制する */
const fitSuspended = ref(false);
let fitSuspendTimer = 0;

watch(explorerOpen, () => {
  fitSuspended.value = true;
  // 過渡期の複数フレームを待ってから解除
  cancelAnimationFrame(fitSuspendTimer);
  fitSuspendTimer = requestAnimationFrame(() => {
    fitSuspendTimer = requestAnimationFrame(() => {
      fitSuspended.value = false;
    });
  });
});

// ファイル選択時に Explorer を自動オープン
watch(
  () => workspaceStore.selectedPath,
  (path) => {
    if (path) explorerOpen.value = true;
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

      <div
        ref="terminalContainer"
        class="min-w-0 flex-1 overflow-hidden p-2"
        :style="{ minWidth: `${TERMINAL_MIN_WIDTH}px` }"
      >
        <TerminalPane
          v-for="d in terminalStore.visitedDirs"
          :key="d"
          v-show="d === workspaceStore.dir"
          :dir="d"
          :fit-suspended="d === workspaceStore.dir ? fitSuspended : undefined"
        />
      </div>

      <!-- Explorer グループ（Filer + Preview）: グループ全体を1ユニットとしてリサイズ -->
      <ResizeHandle
        v-show="explorerOpen && canDockExplorer"
        v-model:after-size="explorerWidth"
        direction="horizontal"
        :before-min-size="TERMINAL_MIN_WIDTH"
        :after-min-size="EXPLORER_MIN_WIDTH"
        :get-before-size="getTerminalWidth"
        :get-after-size="getExplorerWidth"
      />

      <div
        ref="explorerContainer"
        v-show="explorerOpen && canDockExplorer"
        class="flex shrink-0 overflow-hidden"
      >
        <div class="shrink-0 overflow-hidden" :style="{ width: `${filerWidth}px` }">
          <FilerPane />
        </div>

        <ResizeHandle
          v-model:before-size="filerWidth"
          v-model:after-size="previewWidth"
          direction="horizontal"
          :before-min-size="FILER_MIN_WIDTH"
          :after-min-size="PREVIEW_MIN_WIDTH"
        />

        <div class="shrink-0 overflow-hidden" :style="{ width: `${dockedPreviewWidth}px` }">
          <PreviewPane @close="explorerOpen = false" />
        </div>
      </div>

      <!-- Explorer が閉じている、またはドック不可の時に開くボタンを表示 -->
      <button
        v-if="!explorerOpen || !canDockExplorer"
        type="button"
        class="flex shrink-0 items-center justify-center border-l border-zinc-700 px-1 text-zinc-500 hover:text-zinc-300"
        title="Open explorer"
        aria-label="Open explorer"
        @click="explorerOpen = true"
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
            previewWidth,
            leftFixedWidth,
            rightFreeWidth,
            dockedPreviewWidth,
            canDockExplorer,
            windowWidth,
          }"
        />
      </div>
      <div class="w-1/2 overflow-hidden">
        <DiagnosticsPane />
      </div>
    </div>
  </div>
</template>
