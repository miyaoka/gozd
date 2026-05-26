<doc lang="md">
Filer（上）と Changes（下）を垂直分割で表示するコンテナ。

## 動作

- Filer が flex-1 で残りスペースを取り、Changes が固定高さ
- ResizeHandle で上下の比率をリサイズ可能
- git リポジトリでない場合は Filer のみ表示
- FilerPane の reveal は worktreeStore.revealVersion を内部で購読しているため props 経由不要
- FilerPane / ChangesPane の `select` emit はどちらも user-initiated select として `previewStore.requestSelect` を呼ぶ。同一パス再選択でのトグル close / summary 抜けの意思決定は preview store 側に集約されている（[docs/preview.md](../../../../../docs/preview.md) の決定表を参照）

## 右クリックメニュー

FilerPane / ChangesPane (および配下の TreeItem) から `contextMenu` event が bubble してくる。本ペインで singleton popover `useFileContextMenu` を open することで、依存方向を navigator → 子の 1 方向に保つ (子側は navigator を直接 import しない、または type-only import に限る)。

open は VueUse `useTimeoutFn(_, 0)` で 1 task 分遅延させる。`popover="auto"` を contextmenu 同サイクル内で開くと mousedown が light-dismiss を予約し、続く mouseup で即閉じる挙動 (whatwg/html#10905) を回避するため。defer 経路は mouse / keyboard (Shift+F10) / programmatic dispatch のいずれにも非依存。`useTimeoutFn` は effect scope 連動なので unmount / HMR で pending な open が走り残らず、`start` は前の pending を cancel するので連打時は最後の右クリックだけが menu を開く (popover singleton の semantics と整合)。

`dir` / `commitHash` は **右クリック時に snapshot** して popover context に焼き付ける。defer 中 / menu 表示中に worktree や commit 選択が切り替わっても、その右クリックで参照した当時の値を一貫して使う (defer 後に store を読み直すと「古い relPath + 新 dir」の race を生むため)。defer 完了時に anchor 元 component が unmount されていた (`anchorEl.isConnected === false`) ケースは debug log を残して open を skip する。
</doc>

<script setup lang="ts">
import { useElementSize, useTimeoutFn } from "@vueuse/core";
import { ref, useTemplateRef, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { ChangesPane } from "../changes";
import { FilerPane } from "../filer";
import { useGitGraphStore } from "../git-graph";
import { ResizeHandle } from "../layout";
import { usePreviewStore } from "../preview";
import { useWorktreeStore } from "../worktree";
import FileContextMenu from "./FileContextMenu.vue";
import { useFileContextMenu } from "./useFileContextMenu";
import type { FileContextMenuPayload } from "./useFileContextMenu";

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
const gitGraphStore = useGitGraphStore();
const worktreeStore = useWorktreeStore();
const notification = useNotificationStore();

/**
 * 右クリック → menu open までの 1 task 分の defer を effect scope 連動で行うキュー。
 *
 * `useTimeoutFn` の `start(req)` を呼ぶたびに前 pending を cancel して再 schedule する semantics。
 * 連打時は最後の右クリックだけが menu を開く挙動になり、popover singleton の openState
 * 上書き semantics と整合する。unmount / HMR では scope dispose で pending が自動 clear される。
 */
const { start: deferOpenMenu } = useTimeoutFn(
  (req: FileContextMenuPayload, dirSnapshot: string, hashSnapshot: string | undefined) => {
    if (!req.anchorEl.isConnected) {
      notification.debug("[FileContextMenu] anchor disconnected before open, skipping", {
        relPath: req.relPath,
      });
      return;
    }
    openFileContextMenu(req.anchorEl, {
      dir: dirSnapshot,
      relPath: req.relPath,
      commitHash: hashSnapshot,
      x: req.x,
      y: req.y,
    });
  },
  0,
  { immediate: false },
);

/**
 * 配下から bubble してくる contextmenu request を受けて popover singleton を open する。
 *
 * - 同サイクル内の `showPopover` は `popover="auto"` の light-dismiss を続く mouseup が消化して
 *   即閉じるため (whatwg/html#10905)、`useTimeoutFn` で 1 task 分 defer する。入力種別
 *   (mouse / keyboard / programmatic) 非依存
 * - `dir` / `commitHash` は **本関数の同期実行時点** で snapshot する。defer 中に worktree
 *   切替 / commit 選択切替が起きても、その右クリック時点の値を popover context に焼き付ける
 *   ことで「古い relPath + 新 dir」「古い anchor + 新 hash」の race を構造的に排除する
 * - dir 未設定 (起動初期 / 全 repo 閉鎖直後) では menu を出さず debug log
 */
function onFileContextMenu(req: FileContextMenuPayload) {
  const dirSnapshot = worktreeStore.dir;
  if (dirSnapshot === undefined) {
    notification.debug("[FileContextMenu] no active worktree, skipping", { relPath: req.relPath });
    return;
  }
  const hashSnapshot = gitGraphStore.contextMenuHash;
  deferOpenMenu(req, dirSnapshot, hashSnapshot);
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
