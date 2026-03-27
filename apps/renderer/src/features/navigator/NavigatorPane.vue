<doc lang="md">
Filer（上）と Changes（下）を垂直分割で表示するコンテナ。

## 動作

- Filer が flex-1 で残りスペースを取り、Changes が固定高さ
- ResizeHandle で上下の比率をリサイズ可能
- git リポジトリでない場合は Filer のみ表示
- `revealPath` / `revealVersion` props の変化で FilerPane のツリーを自動展開
- ChangesPane の `select` emit を `worktreeStore.selectPath()` に接続
</doc>

<script setup lang="ts">
import { useElementSize } from "@vueuse/core";
import { nextTick, ref, useTemplateRef, watch, watchEffect } from "vue";
import { useProjectStore } from "../../shared/project";
import { ChangesPane } from "../changes";
import { FilerPane } from "../filer";
import { ResizeHandle } from "../layout";
import { useWorktreeStore } from "../worktree";

interface Props {
  revealPath?: string;
  revealVersion?: number;
}

const props = defineProps<Props>();

const HANDLE_HEIGHT = 8;
const FILER_MIN_HEIGHT = 100;
const CHANGES_MIN_HEIGHT = 60;

const projectStore = useProjectStore();
const worktreeStore = useWorktreeStore();
const filerPaneRef = useTemplateRef<InstanceType<typeof FilerPane>>("filerPane");
const filerWrapperRef = useTemplateRef<HTMLElement>("filerWrapper");
const containerRef = useTemplateRef<HTMLElement>("container");
const { height: containerHeight } = useElementSize(containerRef);

const changesHeight = ref(200);

// コンテナ縮小時に changesHeight をクランプ（Filer が潰れるのを防ぐ）
watchEffect(() => {
  const maxChanges = containerHeight.value - FILER_MIN_HEIGHT - HANDLE_HEIGHT;
  if (changesHeight.value > maxChanges) {
    changesHeight.value = Math.max(CHANGES_MIN_HEIGHT, maxChanges);
  }
});

/** Filer ペインの DOM 実測高さ（flex-1 のため v-model 不可） */
function getFilerHeight(): number {
  return filerWrapperRef.value?.offsetHeight ?? FILER_MIN_HEIGHT;
}

function onChangesSelect(relPath: string) {
  worktreeStore.selectPath(relPath);
}

// revealPath / revealVersion の変化で FilerPane のツリーを展開する
watch([() => props.revealPath, () => props.revealVersion], async ([path]) => {
  if (!path) return;
  await nextTick();
  await filerPaneRef.value?.reveal(path);
});
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
        <FilerPane ref="filerPane" />
      </div>
    </div>

    <!-- Changes（git リポジトリのみ） -->
    <template v-if="projectStore.isGitRepo">
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
