<doc lang="md">
Terminal leaf 群を統括するコンテナ。

leaf の CSS Grid レイアウト・分割リサイズハンドル・可視性制御をカプセル化する。
MainLayout はこのコンポーネントを配置するだけでよい。

## レイアウト

- 単一 worktree モード（"wt"）: `treeToGridTemplate` で分割ツリーを CSS Grid に変換
- マルチ表示モード（"all" / "claude"）: `tileGridTemplate` で均等タイル配置
- 各 TerminalLeaf は `grid-area` で配置、非表示 leaf は `v-show:false`
- 分割リサイズハンドルは absolute overlay
</doc>

<script setup lang="ts">
import { useElementSize, useEventListener } from "@vueuse/core";
import { computed, onUnmounted, useTemplateRef, watch } from "vue";
import { useContextKeys } from "../../shared/command";
import { useWorktreeStore } from "../worktree";
import { registerTerminalCommands } from "./registerTerminalCommands";
import SplitResizeHandle from "./SplitResizeHandle.vue";
import {
  collectLeafIds,
  flattenHandles,
  leafIdToAreaName,
  TILE_GAP,
  tileGridTemplate,
  treeToGridTemplate,
} from "./splitTree";
import type { HandlePosition, PixelRect } from "./splitTree";
import TerminalLeaf from "./TerminalLeaf.vue";
import { useTerminalStore } from "./useTerminalStore";

interface Props {
  minWidth: number;
}

const { minWidth } = defineProps<Props>();

const worktreeStore = useWorktreeStore();
const terminalStore = useTerminalStore();
const contextKeys = useContextKeys();
const containerRef = useTemplateRef<HTMLElement>("container");
const { width: containerW, height: containerH } = useElementSize(containerRef);

const currentDir = computed(() => worktreeStore.dir);
const disposeTerminalCommands = registerTerminalCommands(currentDir, containerRef);
onUnmounted(disposeTerminalCommands);

// ウィンドウの表示状態変更時に terminalFocus を同期
// hidden 時は false にリセット、復帰時は activeElement から再判定
// （WKWebView では復帰時に xterm の focus が再発火しない場合がある）
useEventListener(document, "visibilitychange", () => {
  if (document.hidden) {
    contextKeys.set("terminalFocus", false);
  } else {
    const container = containerRef.value;
    const active = document.activeElement;
    const isFocused = container !== null && active !== null && container.contains(active);
    contextKeys.set("terminalFocus", isFocused);
  }
});

// worktree を初めて訪問したときに visitedDirs に登録
// worktree 切り替え時に terminalFocus をリセット
watch(
  () => worktreeStore.dir,
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
  const name = worktreeStore.repoName ?? "gozd";
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
  const dir = worktreeStore.dir;
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

/** grid スタイル */
const gridStyle = computed<Record<string, string>>(() => {
  const mode = terminalStore.viewMode;

  // タイル表示: all / claude
  if (mode === "all" || mode === "claude") {
    const ids = mode === "claude" ? terminalStore.claudeActiveLeafIds : allLeafIds.value;
    const tpl = tileGridTemplate(ids, containerW.value, containerH.value);
    return {
      gridTemplateAreas: tpl.areas,
      gridTemplateColumns: tpl.columns,
      gridTemplateRows: tpl.rows,
    };
  }

  // 単一 worktree: 分割ツリーから grid-template を生成
  const dir = worktreeStore.dir;
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
  const dir = worktreeStore.dir;
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
</script>

<template>
  <div
    ref="container"
    class="relative grid min-w-0 flex-1 overflow-hidden p-2"
    :style="{
      minWidth: `${minWidth}px`,
      gap: `${TILE_GAP}px`,
      background: paneBackground,
      ...gridStyle,
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
      :dir="worktreeStore.dir ?? ''"
      :branch-id="handle.branchId"
      :axis="handle.axis"
      :ratio="handle.ratio"
      :first-node="handle.firstNode"
      :second-node="handle.secondNode"
      :available-px="handle.availablePx"
      :style="handleRectStyle(handle.rect)"
    />
  </div>
</template>
