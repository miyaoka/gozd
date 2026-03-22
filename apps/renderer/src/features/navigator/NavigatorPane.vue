<doc lang="md">
Filer と Changes をタブで切り替えるコンテナ。

## 動作

- ヘッダーのタブボタンで Files / Changes ビューを切り替え
- v-show で切り替えるため、展開状態やスクロール位置が保持される
- FilerPane の `reveal()` を親に再公開
- ChangesPane の `select` emit を `worktreeStore.selectPath()` に接続
</doc>

<script setup lang="ts">
import { ref, useTemplateRef } from "vue";
import { ChangesPane } from "../changes";
import { FilerPane } from "../filer";
import { useWorktreeStore } from "../worktree";

type NavigatorView = "files" | "changes";

const worktreeStore = useWorktreeStore();
const filerPaneRef = useTemplateRef<InstanceType<typeof FilerPane>>("filerPane");
const activeView = ref<NavigatorView>("files");

function onChangesSelect(relPath: string) {
  worktreeStore.selectPath(relPath);
}

/** ツリーを展開する。v-show で DOM は残るのでタブ状態に関わらず動作する */
async function reveal(targetPath: string): Promise<void> {
  await filerPaneRef.value?.reveal(targetPath);
}

defineExpose({ reveal });
</script>

<template>
  <div
    class="flex size-full flex-col overflow-hidden border-l border-zinc-700 bg-zinc-900 text-zinc-300"
  >
    <!-- タブヘッダー -->
    <div class="flex shrink-0 items-center border-b border-zinc-700">
      <button
        type="button"
        class="flex items-center gap-1 px-3 py-1.5 text-xs"
        :class="
          activeView === 'files'
            ? 'font-semibold text-zinc-200'
            : 'text-zinc-500 hover:text-zinc-300'
        "
        @click="activeView = 'files'"
      >
        <span class="icon-[lucide--folder-tree] size-3.5" />
        Files
      </button>
      <button
        type="button"
        class="flex items-center gap-1 px-3 py-1.5 text-xs"
        :class="
          activeView === 'changes'
            ? 'font-semibold text-zinc-200'
            : 'text-zinc-500 hover:text-zinc-300'
        "
        @click="activeView = 'changes'"
      >
        <span class="icon-[lucide--git-branch] size-3.5" />
        Changes
      </button>
    </div>

    <!-- ビュー本体 -->
    <div v-show="activeView === 'files'" class="min-h-0 flex-1 overflow-hidden">
      <FilerPane ref="filerPane" />
    </div>
    <div v-show="activeView === 'changes'" class="min-h-0 flex-1 overflow-hidden">
      <ChangesPane @select="onChangesSelect" />
    </div>
  </div>
</template>
