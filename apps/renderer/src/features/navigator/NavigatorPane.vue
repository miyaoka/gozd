<doc lang="md">
Filer（上）と Changes（下）を垂直分割で表示するコンテナ。

## 動作

- Filer が flex-1 で残りスペースを取り、Changes が固定高さ
- ResizeHandle で上下の比率をリサイズ可能
- git リポジトリでない場合は Filer のみ表示
- FilerPane の reveal は worktreeStore.revealVersion を内部で購読しているため props 経由不要
- FilerPane / ChangesPane の `select` emit はどちらも user-initiated select として `previewStore.requestSelect` を呼ぶ。同一パス再選択でのトグル close / summary 抜けの意思決定は preview store 側に集約されている（[docs/preview.md](../../../../../docs/preview.md) の決定表を参照）

## 右クリックメニュー

FilerPane / ChangesPane (および配下の TreeItem) から `contextMenu` event を受けて singleton popover (`useFileContextMenu`) に橋渡しする。子側は navigator への直接依存を持たない (payload 型のみ type-only import) ため、依存方向は navigator → 子の 1 方向で閉じる。pointerup once-capture による light-dismiss 回避 / dir / hash snapshot / disconnect ガード等の内部仕様は `useFileContextMenu.ts` の docstring を SSOT として参照する。
</doc>

<script setup lang="ts">
import { useElementSize, useEventListener } from "@vueuse/core";
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

type PendingOpen = {
  payload: FileContextMenuPayload;
  dir: string;
  hash: string | undefined;
};

/**
 * 右クリックで積まれる pending open。次の `pointerup` で処理して open する。
 * 連打時は最後の右クリックが pending を上書き (popover singleton の openState 上書き
 * semantics と整合 — 最後の値だけが意味を持つ)。cancel を log しないのは意図的:
 * user 連打のたびに console を汚すノイズになるため、観察可能性より signal-to-noise を優先する。
 */
const pendingOpen = ref<PendingOpen | null>(null);

/**
 * window 全体に常設する `pointerup` capture listener。pending が積まれていれば消化して open する。
 *
 * **不変条件 (実装変更時に必読)**:
 * - `setTimeout(0)` / `requestAnimationFrame` / `queueMicrotask` 等の task / microtask defer は
 *   WebKit (WebPage) の `popover="auto"` light-dismiss を **抜けない** (実機検証済)。続く mouseup が
 *   popover に到達して即 dismiss される (whatwg/html#10905)
 * - `pointerup` を `capture: true` で window に貼ると、popover が show される **前** に listener が
 *   pointerup を消化する → 続く mouseup は popover open 前の press cycle として扱われ
 *   light-dismiss の対象外になる。`{ capture: true }` を外したり、pointerdown / mousedown 経路に
 *   変えてはならない
 * - keyboard 経路 (Shift+F10 / Apps key) と programmatic dispatch は pointerup が発火しないため
 *   menu は開かない。本 PR の責務外で、将来 keyboard ショートカット要件が発生したら別経路
 *   ([docs/keybinding.md](../../../../../docs/keybinding.md)) で menu を開く
 *
 * `useEventListener` を setup 直下で呼ぶことで effect scope に紐付き、unmount / HMR で自動 cleanup
 * される (handler 内で呼ぶと scope に登録されず leak する)。
 */
useEventListener(
  window,
  "pointerup",
  () => {
    const pending = pendingOpen.value;
    if (!pending) return;
    pendingOpen.value = null;
    if (!pending.payload.anchorEl.isConnected) {
      notification.debug("[FileContextMenu] anchor disconnected before open, skipping", {
        relPath: pending.payload.relPath,
      });
      return;
    }
    openFileContextMenu(pending.payload.anchorEl, {
      dir: pending.dir,
      relPath: pending.payload.relPath,
      commitHash: pending.hash,
      x: pending.payload.x,
      y: pending.payload.y,
    });
  },
  { capture: true },
);

/**
 * 配下から bubble してくる contextmenu request を pending に積む。
 *
 * - `dir` / `commitHash` は **本関数の同期実行時点** で snapshot する。pointerup 待機中に
 *   worktree 切替 / commit 選択切替が起きても、その右クリック時点の値を popover context に
 *   焼き付けることで「古い relPath + 新 dir」「古い anchor + 新 hash」の race を構造的に排除する
 * - `dir` 未設定 (起動初期 / 全 repo 閉鎖直後) では menu を出さず debug log。FilerPane は
 *   `v-if="!dir"` で "waiting for open command..." を出してツリー自体を描画しないため、user
 *   操作経路ではこの分岐に到達しない (defensive)。観測対象が user 不可視の異常系なので
 *   `info` toast ではなく `debug` のまま (toast にすると正常状態と区別しにくい)
 */
function onFileContextMenu(req: FileContextMenuPayload) {
  const dirSnapshot = worktreeStore.dir;
  if (dirSnapshot === undefined) {
    notification.debug("[FileContextMenu] no active worktree, skipping", { relPath: req.relPath });
    return;
  }
  pendingOpen.value = {
    payload: req,
    dir: dirSnapshot,
    hash: gitGraphStore.contextMenuHash,
  };
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
