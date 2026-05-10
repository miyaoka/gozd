<doc lang="md">
Terminal leaf 群を統括するコンテナ。

leaf の CSS Grid レイアウト・分割リサイズハンドル・可視性制御をカプセル化する。
MainLayout はこのコンポーネントを配置するだけでよい。

## レイアウト

- 単一 worktree モード（"wt"）: `treeToGridTemplate` で分割ツリーを CSS Grid に変換
- Claude タイルモード（"claude"）: `tileGridTemplate` で Claude 起動中 leaf を均等タイル配置
- 各 TerminalLeaf は `grid-area` で配置、非表示 leaf は `v-show:false`
- 分割リサイズハンドルは absolute overlay
</doc>

<script setup lang="ts">
import { useElementSize, useEventListener } from "@vueuse/core";
import { computed, onUnmounted, useTemplateRef, watch } from "vue";
import { useContextKeys } from "../../shared/command";
import { useRepoStore } from "../../shared/repo";
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
const repoStore = useRepoStore();
const terminalStore = useTerminalStore();
const contextKeys = useContextKeys();
const containerRef = useTemplateRef<HTMLElement>("container");
const { width: containerW, height: containerH } = useElementSize(containerRef);

const currentDir = computed(() => worktreeStore.dir);
const disposeTerminalCommands = registerTerminalCommands(currentDir, containerRef);
onUnmounted(disposeTerminalCommands);

/**
 * activeElement が terminal コンテナ内にあるかで terminalFocus を再判定する。
 * unconditional false にすると、terminal の focus が dir 変更を引き起こす経路
 * （cross-cutting view で別 worktree の leaf に focus 移動）で context key が
 * 落ちて keybinding が外れるため、DOM の真の focus 状態から逆引きする。
 */
function syncTerminalFocusFromActiveElement() {
  const container = containerRef.value;
  const active = document.activeElement;
  const isFocused = container !== null && active !== null && container.contains(active);
  contextKeys.set("terminalFocus", isFocused);
}

// ウィンドウの表示状態変更時に terminalFocus を同期
// hidden 時は false にリセット、復帰時は activeElement から再判定
// （WKWebView では復帰時に xterm の focus が再発火しない場合がある）
useEventListener(document, "visibilitychange", () => {
  if (document.hidden) {
    contextKeys.set("terminalFocus", false);
  } else {
    syncTerminalFocusFromActiveElement();
  }
});

// worktree を初めて訪問したときに visitedDirs に登録
// dir 変更時は activeElement から再判定する（terminal 起点の dir 変更なら focus は維持）
watch(
  () => worktreeStore.dir,
  (dir) => {
    syncTerminalFocusFromActiveElement();
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
  const name = repoStore.selectedRepoName ?? "gozd";
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
  if (terminalStore.viewMode === "claude") return new Set(terminalStore.claudeActiveLeafIds);
  return new Set(activeLeafIds.value);
});

const EMPTY_GRID: Record<string, string> = {
  gridTemplateColumns: "1fr",
  gridTemplateRows: "1fr",
  gridTemplateAreas: '"."',
};

/** grid スタイル */
const gridStyle = computed<Record<string, string>>(() => {
  // Claude タイル表示
  if (terminalStore.viewMode === "claude") {
    const tpl = tileGridTemplate(
      terminalStore.claudeActiveLeafIds,
      containerW.value,
      containerH.value,
    );
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
