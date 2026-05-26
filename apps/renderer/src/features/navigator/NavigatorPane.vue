<doc lang="md">
Filer（上）と Changes（下）を垂直分割で表示するコンテナ。

## 動作

- Filer が flex-1 で残りスペースを取り、Changes が固定高さ
- ResizeHandle で上下の比率をリサイズ可能
- git リポジトリでない場合は Filer のみ表示
- FilerPane の reveal は worktreeStore.revealVersion を内部で購読しているため props 経由不要
- FilerPane / ChangesPane の `select` emit はどちらも user-initiated select として `previewStore.requestSelect` を呼ぶ。同一パス再選択でのトグル close / summary 抜けの意思決定は preview store 側に集約されている（[docs/preview.md](../../../../../docs/preview.md) の決定表を参照）

## 右クリックメニュー

FilerPane / ChangesPane (および配下の TreeItem) から `contextMenu` event が bubble してくる。本ペインで singleton popover `useFileContextMenu` を open することで、依存方向を navigator → 子の 1 方向に保つ (子側は navigator を直接 import しない)。

open は `setTimeout(open, 0)` で 1 task 分遅延させる。`popover="auto"` を contextmenu 同サイクル内で開くと mousedown が light-dismiss を予約し、続く mouseup で即閉じる挙動 (whatwg/html#10905) を回避するため。setTimeout 経路は mouse / keyboard (Shift+F10) / programmatic dispatch のいずれにも非依存に動く。
</doc>

<script setup lang="ts">
import { useElementSize } from "@vueuse/core";
import { ref, useTemplateRef, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { ChangesPane } from "../changes";
import { FilerPane } from "../filer";
import { ResizeHandle } from "../layout";
import { usePreviewStore } from "../preview";
import FileContextMenu from "./FileContextMenu.vue";
import { useFileContextMenu } from "./useFileContextMenu";

/** contextmenu event payload (FilerPane / ChangesPane から bubble してくる) */
type FileContextMenuRequest = {
  anchorEl: HTMLElement;
  relPath: string;
  commitHash?: string;
  x: number;
  y: number;
};

const HANDLE_HEIGHT = 8;
const FILER_MIN_HEIGHT = 100;
const CHANGES_MIN_HEIGHT = 60;

const repoStore = useRepoStore();
const previewStore = usePreviewStore();
const filerWrapperRef = useTemplateRef<HTMLElement>("filerWrapper");
const containerRef = useTemplateRef<HTMLElement>("container");
const { height: containerHeight } = useElementSize(containerRef);

const changesHeight = ref(360);

// コンテナ縮小時に changesHeight をクランプ（Filer が潰れるのを防ぐ）
// useElementSize は mount 直後 0 を返すため、計測前は clamp をスキップする。
// watch source は外因（containerHeight）だけにする。changesHeight は書き換え対象なので
// source に含めると再帰発火経路が混入する（user resize は別ロジックでクランプ済み）。
watch(
  containerHeight,
  (h) => {
    if (h <= 0) return;
    const maxChanges = h - FILER_MIN_HEIGHT - HANDLE_HEIGHT;
    if (changesHeight.value > maxChanges) {
      changesHeight.value = Math.max(CHANGES_MIN_HEIGHT, maxChanges);
    }
  },
  { immediate: true },
);

/** Filer ペインの DOM 実測高さ（flex-1 のため v-model 不可） */
function getFilerHeight(): number {
  return filerWrapperRef.value?.offsetHeight ?? FILER_MIN_HEIGHT;
}

function onFileSelect(relPath: string) {
  previewStore.requestSelect({ kind: "worktreeRelative", relPath });
}

const { open: openFileContextMenu } = useFileContextMenu();

// contextmenu の発火サイクル (mousedown → contextmenu → mouseup) を 1 task 分抜けてから
// showPopover を呼ぶ。同サイクル内 open は whatwg/html#10905 で続く mouseup が light-dismiss
// として消化される。setTimeout(0) は入力種別 (マウス / キーボード / programmatic) 非依存。
function onFileContextMenu(req: FileContextMenuRequest) {
  setTimeout(() => {
    openFileContextMenu(req.anchorEl, {
      relPath: req.relPath,
      commitHash: req.commitHash,
      x: req.x,
      y: req.y,
    });
  }, 0);
}
</script>

<template>
  <div
    ref="container"
    class="flex size-full flex-col overflow-hidden border-l border-zinc-700 bg-zinc-900 text-zinc-300"
  >
    <!-- Filer -->
    <div ref="filerWrapper" class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="flex shrink-0 items-center border-b border-zinc-700">
        <span class="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-zinc-200">
          <span class="icon-[lucide--folder-tree] size-3.5" />
          Files
        </span>
      </div>
      <div class="min-h-0 flex-1 overflow-hidden">
        <FilerPane @select="onFileSelect" @context-menu="onFileContextMenu" />
      </div>
    </div>

    <!-- Changes（git リポジトリのみ） -->
    <template v-if="repoStore.selectedIsGitRepo">
      <ResizeHandle
        v-model:after-size="changesHeight"
        direction="vertical"
        :before-min-size="FILER_MIN_HEIGHT"
        :after-min-size="CHANGES_MIN_HEIGHT"
        :get-before-size="getFilerHeight"
      />
      <div class="shrink-0 overflow-hidden" :style="{ height: `${changesHeight}px` }">
        <ChangesPane @select="onFileSelect" @context-menu="onFileContextMenu" />
      </div>
    </template>

    <!-- ファイル行の右クリックメニュー (Filer / Changes 共用) -->
    <FileContextMenu />
  </div>
</template>
