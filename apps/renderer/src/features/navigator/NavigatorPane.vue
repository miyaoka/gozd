<doc lang="md">
Filer（上）と Changes（下）を垂直分割で表示するコンテナ。

## 動作

- Filer が flex-1 で残りスペースを取り、Changes が固定高さ
- ResizeHandle で上下の比率をリサイズ可能
- git リポジトリでない場合は Filer のみ表示
- FilerPane の reveal は worktreeStore.revealVersion を内部で購読しているため props 経由不要
- ChangesPane の `select` emit を `worktreeStore.selectRelPath()` に接続
</doc>

<script setup lang="ts">
import { useElementSize } from "@vueuse/core";
import { ref, useTemplateRef, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { ChangesPane } from "../changes";
import { FilerPane } from "../filer";
import { ResizeHandle } from "../layout";
import { useWorktreeStore } from "../worktree";

const HANDLE_HEIGHT = 8;
const FILER_MIN_HEIGHT = 100;
const CHANGES_MIN_HEIGHT = 60;

const repoStore = useRepoStore();
const worktreeStore = useWorktreeStore();
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

function onChangesSelect(relPath: string) {
  worktreeStore.selectRelPath(relPath);
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
        <FilerPane />
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
        <ChangesPane @select="onChangesSelect" />
      </div>
    </template>
  </div>
</template>
