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
import { useElementSize, useEventListener, useWindowSize } from "@vueuse/core";
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch, watchEffect } from "vue";
import { useCommandRegistry, useContextKeys } from "../../shared/command";
import { useRpc } from "../../shared/rpc";
import { DebugPane } from "../debug";
import { DiagnosticsPane } from "../diagnostics";
import { FilerPane, useWorkspaceStore } from "../filer";
import { PreviewPane } from "../preview";
import { SidebarPane } from "../sidebar";
import {
  collectLeafIds,
  flattenHandles,
  leafIdToAreaName,
  registerTerminalCommands,
  SplitResizeHandle,
  TerminalLeaf,
  TILE_GAP,
  tileGridTemplate,
  treeToGridTemplate,
  useTerminalStore,
} from "../terminal";
import type { HandlePosition, PixelRect } from "../terminal";
import ResizeHandle from "./ResizeHandle.vue";

const workspaceStore = useWorkspaceStore();
const terminalStore = useTerminalStore();
const contextKeys = useContextKeys();
const terminalContainerRef = useTemplateRef<HTMLElement>("terminalContainer");
const { width: containerW, height: containerH } = useElementSize(terminalContainerRef);
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

// --- ターミナル背景 ---

/** 文字列から簡易ハッシュ値を生成する（djb2） */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

/** ハッシュ値からパステル HSL 色を生成。hueOffset で類似色をずらす */
function hashToColor(hash: number, hueOffset = 0): string {
  const hue = ((hash % 360) + hueOffset) % 360;
  const saturation = 20 + ((hash >>> 12) % 15);
  const lightness = 60 + ((hash >>> 24) % 25);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

const HUE_OFFSET = 30;

const paneBackground = computed(() => {
  const name = workspaceStore.repoName ?? "gozd";
  const hash = hashString(name);
  const color1 = hashToColor(hash);
  const color2 = hashToColor(hash, HUE_OFFSET);
  return `linear-gradient(0deg, ${color1} 0%, ${color2} 100%)`;
});

// --- ターミナル Grid レイアウト ---
// 全 worktree の全 leaf をフラットに1つの CSS Grid で管理する。
// 表示モード（単一 wt / Claude のみ）に応じて grid-template を切り替え。
// 各 TerminalLeaf は grid-area で配置し、非表示 leaf は v-show:false。
// リサイズハンドルは absolute overlay。

/** アクティブ worktree の全 leafId */
const activeLeafIds = computed(() => {
  const dir = workspaceStore.dir;
  if (!dir) return [];
  const layout = terminalStore.layoutsByDir[dir];
  if (layout === undefined) return [];
  return collectLeafIds(layout.root);
});

/** 全 worktree の全 leafId */
const allLeafIds = computed(() => {
  const ids: string[] = [];
  for (const dir of terminalStore.visitedDirs) {
    const layout = terminalStore.layoutsByDir[dir];
    if (layout === undefined) continue;
    ids.push(...collectLeafIds(layout.root));
  }
  return ids;
});

/** 表示対象の leafId set（v-show の判定に使用） */
const visibleLeafIds = computed(() => {
  const mode = terminalStore.viewMode;
  if (mode === "all") return new Set(allLeafIds.value);
  if (mode === "claude") return new Set(terminalStore.claudeActiveLeafIds);
  return new Set(activeLeafIds.value);
});

const EMPTY_GRID: Record<string, string> = {
  gridTemplateColumns: "1fr",
  gridTemplateRows: "1fr",
  gridTemplateAreas: '"."',
};

/** terminalContainer の grid スタイル */
const terminalGridStyle = computed<Record<string, string>>(() => {
  const mode = terminalStore.viewMode;

  // タイル表示: all / claude
  if (mode === "all" || mode === "claude") {
    const ids = mode === "claude" ? terminalStore.claudeActiveLeafIds : allLeafIds.value;
    const tpl = tileGridTemplate(ids, terminalWidth.value, mainHeight.value);
    return {
      gridTemplateAreas: tpl.areas,
      gridTemplateColumns: tpl.columns,
      gridTemplateRows: tpl.rows,
    };
  }

  // 単一 worktree: 分割ツリーから grid-template を生成
  const dir = workspaceStore.dir;
  if (!dir) return EMPTY_GRID;
  const layout = terminalStore.layoutsByDir[dir];
  if (layout === undefined) return EMPTY_GRID;
  const tpl = treeToGridTemplate(layout.root);
  return {
    gridTemplateAreas: tpl.areas,
    gridTemplateColumns: tpl.columns,
    gridTemplateRows: tpl.rows,
  };
});

/** wt モード以外ではハンドル不要 */
const isTileMode = computed(() => terminalStore.viewMode !== "wt");

/** 分割ツリーのハンドル（タイルモード時は空） */
const handles = computed<HandlePosition[]>(() => {
  if (isTileMode.value) return [];
  const dir = workspaceStore.dir;
  if (!dir) return [];
  const layout = terminalStore.layoutsByDir[dir];
  if (layout === undefined) return [];
  if (containerW.value <= 0 || containerH.value <= 0) return [];
  return flattenHandles(layout.root, containerW.value, containerH.value, TILE_GAP);
});

/** コンテナの padding（p-2 = 8px）。absolute の基準は padding box なので gap 位置にオフセットが必要 */
const CONTAINER_PADDING = 8;

function handleRectStyle(rect: PixelRect): Record<string, string> {
  return {
    position: "absolute",
    top: `${rect.top + CONTAINER_PADDING}px`,
    left: `${rect.left + CONTAINER_PADDING}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

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

// gozdOpen で同一パスが指定された場合にも explorer を開いてツリーを展開する
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
        class="relative grid min-w-0 flex-1 overflow-hidden p-2"
        :style="{
          minWidth: `${TERMINAL_MIN_WIDTH}px`,
          gap: `${TILE_GAP}px`,
          background: paneBackground,
          ...terminalGridStyle,
        }"
      >
        <TerminalLeaf
          v-for="leafId in allLeafIds"
          :key="leafId"
          v-show="visibleLeafIds.has(leafId)"
          :style="{ gridArea: leafIdToAreaName(leafId) }"
          :dir="terminalStore.getPaneDir(leafId) ?? ''"
          :leaf-id="leafId"
        />
        <!-- 分割リサイズハンドル（absolute overlay） -->
        <SplitResizeHandle
          v-for="handle in handles"
          :key="handle.branchId"
          :dir="workspaceStore.dir ?? ''"
          :branch-id="handle.branchId"
          :axis="handle.axis"
          :ratio="handle.ratio"
          :first-node="handle.firstNode"
          :second-node="handle.secondNode"
          :available-px="handle.availablePx"
          :style="handleRectStyle(handle.rect)"
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
