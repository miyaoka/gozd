<doc lang="md">
ファイルツリーのルートコンテナ。

## 動作

- worktree の dir が設定されると、worktree 自体を表す不可視ルート FileTreeItem を 1 個描画する
- ツリー全体（ルート直下を含む）の管理は FileTreeItem 側に再帰委譲する
- fsChange / gitStatusChange の RPC メッセージを購読し、filer event store 経由で各 FileTreeItem に通知する
- dir 切替時は `:key="dir"` でルート FileTreeItem を再マウントする（旧 dir の in-flight loadChildren を構造的に破棄）
</doc>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { onUnmounted } from "vue";
import { onMessage } from "../../shared/rpc";
import { useGitStatusStore, useWorktreeStore } from "../worktree";
import type { GitStatusChangePayload } from "../worktree";
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

function handleGitStatusChange(eventDir: string) {
  // useFsWatchSync は全 worktree を watch するため、別 worktree の gitStatusChange も
  // 到達する。active worktree dir 以外は無視して空打ちの再 merge を防ぐ。
  if (eventDir !== dir.value) return;
  filerEventStore.emitGitStatusChange();
}

const unsubscribeFsChange = onMessage<FsChangePayload>("fsChange", ({ dir: eventDir, relDir }) =>
  handleFsChange(eventDir, relDir),
);
const unsubscribeGitStatus = onMessage<GitStatusChangePayload>(
  "gitStatusChange",
  ({ dir: eventDir }) => handleGitStatusChange(eventDir),
);
onUnmounted(() => {
  unsubscribeFsChange();
  unsubscribeGitStatus();
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
        :is-root="true"
        @select="onSelect"
      />
    </div>
  </div>
</template>
