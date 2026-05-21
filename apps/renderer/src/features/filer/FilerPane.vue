<doc lang="md">
ファイルツリーのルートコンテナ。

## 動作

- worktree の dir が設定されると、worktree 自体を表す不可視ルート FileTreeItem を 1 個描画する
- ツリー全体（ルート直下を含む）の管理は FileTreeItem 側に再帰委譲する
- dir 切替時は `:key="dir"` でルート FileTreeItem を再マウントする（旧 dir の in-flight loadChildren を構造的に破棄）

## gitStatus / fsChange の購読

- `fsChange` push は `dir` フィルタを通して `filerEventStore.emitFsChange(relDir)` に流す
- `gitStatuses` は `useGitStatusStore` の computed（`repoStore` 派生）で、初回 `loadGitStatus()` 完了 / `gitStatusChange` push の両経路で更新される。これを `watch` して `filerEventStore.emitGitStatusChange()` を発火することで、両経路を 1 本のトリガに揃える（初回マウント直後に削除仮想エントリが取りこぼされる race を解消）
</doc>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { onUnmounted, watch } from "vue";
import { onMessage } from "../../shared/rpc";
import { useGitStatusStore, useWorktreeStore } from "../worktree";
import FileTreeItem from "./FileTreeItem.vue";
import type { FsChangePayload } from "./rpc";
import { useFilerEventStore } from "./useFilerEventStore";

const worktreeStore = useWorktreeStore();
const { dir, selectedRelPath } = storeToRefs(worktreeStore);
const gitStatusStore = useGitStatusStore();
const { gitStatuses } = storeToRefs(gitStatusStore);
const filerEventStore = useFilerEventStore();

function onSelect(path: string) {
  worktreeStore.selectRelPath(path);
}

function handleFsChange(eventDir: string, relDir: string) {
  // useFsWatchSync は全 worktree を watch するため、別 repo / 別 worktree の
  // fsChange も到達する。active worktree dir 以外は無視する。
  if (eventDir !== dir.value) return;
  // ルート（relDir === ""）も子も filer event store 経由で対応 FileTreeItem に通知する。
  // ルートノードは props.path === "" で同 relDir を購読しているため特別分岐は不要。
  filerEventStore.emitFsChange(relDir);
}

// gitStatuses は useGitStatusStore の computed で、初回 loadGitStatus() 完了と
// gitStatusChange push の両方が同じ ref を更新する SSOT。ここを watch することで、
// 両経路の更新を 1 本のトリガ（emitGitStatusChange）に揃える。
// dir 切替時にも computed の値は変わるが、ルート FileTreeItem は `:key="dir"` で
// 再マウントされるため、世代カウンタによる race ガード（FileTreeItem.loadChildren）と
// 重複しても挙動は最終的に整合する。
//
// 暗黙契約: `useRepoStore.setWorktreeGitStatuses` が呼ばれるたびに worktree object と
// gitStatuses の reference を新規生成すること。両 push / 初回 RPC ともに deserialize 由来の
// 新規オブジェクトを渡すので reference 同一性は保たれる。同 reference を渡す最適化が将来
// 入る場合は、shared 層で書き込み version ref を持たせて filer がそれを watch する経路に
// 切り替える必要がある。
watch(gitStatuses, () => {
  filerEventStore.emitGitStatusChange();
});

const unsubscribeFsChange = onMessage<FsChangePayload>("fsChange", ({ dir: eventDir, relDir }) =>
  handleFsChange(eventDir, relDir),
);
onUnmounted(() => {
  unsubscribeFsChange();
});
</script>

<template>
  <div class="flex size-full flex-col">
    <!-- ツリー本体 -->
    <div class="flex-1 overflow-y-auto p-1">
      <div v-if="!dir" class="px-2 py-4 text-center text-sm text-zinc-500">
        waiting for open command...
      </div>
      <FileTreeItem
        v-else
        :key="dir"
        name=""
        path=""
        :is-directory="true"
        :is-ignored="false"
        :git-statuses="gitStatuses"
        :depth="-1"
        :selected-rel-path="selectedRelPath"
        @select="onSelect"
      />
    </div>
  </div>
</template>
