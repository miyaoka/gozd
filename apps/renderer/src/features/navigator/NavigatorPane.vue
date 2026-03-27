<doc lang="md">
Filer と Changes をタブで切り替えるコンテナ。

## 動作

- ヘッダーのタブボタンで Files / Changes ビューを切り替え
- v-show で切り替えるため、展開状態やスクロール位置が保持される
- FilerPane の `reveal()` を親に再公開
- ChangesPane の `select` emit を `worktreeStore.selectPath()` に接続
- git-graph でコミットを選択すると自動的に Changes タブをアクティブにする
- changes の内容変化、または changes にあるファイルの変化で自動的に Changes タブをアクティブにする
</doc>

<script setup lang="ts">
import { onUnmounted, ref, useTemplateRef, watch } from "vue";
import { useProjectStore } from "../../shared/project";
import { useRpc } from "../../shared/rpc";
import { ChangesPane } from "../changes";
import { FilerPane } from "../filer";
import { useGitGraphStore } from "../git-graph";
import { useGitStatusStore, useWorktreeStore } from "../worktree";

type NavigatorView = "files" | "changes";

const gitGraphStore = useGitGraphStore();
const gitStatusStore = useGitStatusStore();
const projectStore = useProjectStore();
const worktreeStore = useWorktreeStore();
const { onGitStatusChange } = useRpc();
const filerPaneRef = useTemplateRef<InstanceType<typeof FilerPane>>("filerPane");
const activeView = ref<NavigatorView>("files");

/** git-graph でコミットを選択したら Changes タブをアクティブにする。
 * selectionVersion は select / selectCompare でのみインクリメントされるため、
 * resetSelection（worktree 切替等）では発火しない */
watch(
  () => gitGraphStore.selectionVersion,
  () => {
    activeView.value = "changes";
  },
);

/** changes の内容変化で切り替える（git clean, commit, worktree 切り替え等） */
watch(
  () =>
    Object.entries(gitStatusStore.gitStatuses)
      .map(([filePath, status]) => `${filePath}\0${status}`)
      .sort()
      .join("\n"),
  () => {
    activeView.value = "changes";
  },
);

/** changes にあるファイルの変化で切り替える（statuses 内容は同じだがイベントは発火する） */
const unsubscribeGitStatus = onGitStatusChange(({ statuses }) => {
  if (Object.keys(statuses).length > 0) {
    activeView.value = "changes";
  }
});
onUnmounted(() => {
  unsubscribeGitStatus();
});

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
        v-if="projectStore.isGitRepo"
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
    <div
      v-if="projectStore.isGitRepo"
      v-show="activeView === 'changes'"
      class="min-h-0 flex-1 overflow-hidden"
    >
      <ChangesPane @select="onChangesSelect" />
    </div>
  </div>
</template>
