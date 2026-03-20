<doc lang="md">
アプリ全体のレイアウトを構成するコンテナ。

## 構成

- 水平方向: SidebarPane → TerminalPane（各ペイン間にリサイズハンドル）
- 垂直方向: メインエリア → DebugPane（リサイズハンドル）
- Explorer（FilerPane + PreviewPane）は Popover API でトップレイヤーに配置し、レイアウトフローから分離

## リサイズ

各ハンドルは隣接する左右（上下）のペインだけを連動してリサイズする。
ハンドルより遠いペインには影響しない。
</doc>

<script setup lang="ts">
import { useEventListener, useWindowSize } from "@vueuse/core";
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch, watchEffect } from "vue";
import { useCommandRegistry } from "../command/useCommandRegistry";
import { useContextKeys } from "../command/useContextKeys";
import DebugPane from "../debug/DebugPane.vue";
import DiagnosticsPane from "../diagnostics/DiagnosticsPane.vue";
import FilerPane from "../filer/FilerPane.vue";
import { useWorkspaceStore } from "../filer/useWorkspaceStore";
import PreviewPane from "../preview/PreviewPane.vue";
import { useRpc } from "../rpc/useRpc";
import SidebarPane from "../sidebar/SidebarPane.vue";
import { registerTerminalCommands } from "../terminal/registerTerminalCommands";
import { computeTileLayout, TILE_GAP } from "../terminal/splitTree";
import TerminalPane from "../terminal/TerminalPane.vue";
import { useTerminalStore } from "../terminal/useTerminalStore";
import ResizeHandle from "./ResizeHandle.vue";

const workspaceStore = useWorkspaceStore();
const terminalStore = useTerminalStore();
const contextKeys = useContextKeys();
const terminalContainerRef = useTemplateRef<HTMLElement>("terminalContainer");
const explorerPopoverRef = useTemplateRef<HTMLElement>("explorerPopover");
const filerPaneRef = useTemplateRef<InstanceType<typeof FilerPane>>("filerPane");

const currentDir = computed(() => workspaceStore.dir);
const disposeTerminalCommands = registerTerminalCommands(currentDir, terminalContainerRef);
onUnmounted(disposeTerminalCommands);

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

// --- ターミナル Grid レイアウト ---
// terminalContainer は worktree 単位のグリッド。
// 単一表示: 1x1、全表示: NxM でタイル配置。
// 各 TerminalPane 内部の leaf/handle 配置は TerminalPane が自己管理する。

/** worktree のエリア名を生成する。visitedDirs のインデックスで一意性を保証 */
function worktreeAreaName(index: number): string {
  return `wt${index}`;
}

/** terminalContainer の grid スタイル */
const terminalGridStyle = computed<Record<string, string>>(() => {
  const dirs = terminalStore.visitedDirs;
  const count = dirs.length;

  if (terminalStore.showAll && count > 0) {
    const { cols } = computeTileLayout(count, terminalWidth.value, mainHeight.value);
    const rows = Math.ceil(count / cols);

    // areas マトリクスを構築
    const areaRows: string[] = [];
    for (let r = 0; r < rows; r++) {
      const cells: string[] = [];
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        cells.push(i < count ? worktreeAreaName(i) : ".");
      }
      areaRows.push(`"${cells.join(" ")}"`);
    }

    return {
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gridTemplateRows: `repeat(${rows}, 1fr)`,
      gridTemplateAreas: areaRows.join(" "),
    };
  }

  // 単一表示: アクティブ worktree だけ表示
  const activeIndex = dirs.indexOf(workspaceStore.dir ?? "");
  const areaName = activeIndex >= 0 ? worktreeAreaName(activeIndex) : "empty";
  return {
    gridTemplateColumns: "1fr",
    gridTemplateRows: "1fr",
    gridTemplateAreas: `"${areaName}"`,
  };
});

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

/** ドラッグ開始時に Terminal の DOM 実測幅を取得する */
const getTerminalWidth = () =>
  terminalContainerRef.value?.getBoundingClientRect().width ?? terminalWidth.value;

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
  () => workspaceStore.selectedPath,
  async (path) => {
    if (!path) return;
    openExplorer();
    await nextTick();
    void filerPaneRef.value?.reveal(path);
  },
);

// orkisOpen で同一パスが指定された場合にも explorer を開いてツリーを展開する
watch(
  () => workspaceStore.revealVersion,
  async () => {
    const path = workspaceStore.selectedPath;
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

      <div
        ref="terminalContainer"
        class="grid min-w-0 flex-1 overflow-hidden p-2"
        :style="{
          minWidth: `${TERMINAL_MIN_WIDTH}px`,
          gap: terminalStore.showAll ? `${TILE_GAP}px` : undefined,
          ...terminalGridStyle,
        }"
      >
        <TerminalPane
          v-for="(d, i) in terminalStore.visitedDirs"
          :key="d"
          v-show="terminalStore.showAll || d === workspaceStore.dir"
          :style="{ gridArea: worktreeAreaName(i) }"
          :dir="d"
        />
      </div>

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
