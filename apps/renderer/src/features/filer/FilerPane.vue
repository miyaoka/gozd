<doc lang="md">
ファイルツリーのルートコンテナ。

## 動作

- worktree の dir が設定されると、worktree 自体を表す不可視ルート FileTreeItem を 1 個描画する
- ツリー全体（ルート直下を含む）の管理は FileTreeItem 側に再帰委譲する
- ルート FileTreeItem は `:key="\`${dir}:${snapshotHash ?? ''}\`"` で再マウントする
  （dir 切替 / snapshot mode 切替の双方で in-flight loadChildren を構造的に破棄するため）
- file クリックは `select` emit で親に委譲する（副作用は親側で扱う / ChangesPane と対称）

## snapshot mode

- git-graph で UNCOMMITTED_HASH 以外の commit が選択されているとき、filer は
  「そのコミット時点の全 tree」を表示する snapshot mode に切り替わる
- `snapshotHash` が真値のとき FileTreeItem は `rpcGitLsTree` を呼び、git status / fsChange
  との連動を抑止する（過去コミットの tree に working tree の status を重ねるのは誤情報）
- snapshot mode 中にファイルをクリックすると `selectedRelPath` が更新され、preview は
  既存 CommitMode 経路 (`gitShowCommitFile`) で from/to を取得する

## gitStatus / fsChange の購読

- `fsChange` push は `dir` フィルタを通して `filerEventStore.emitFsChange(relDir)` に流す
- `gitStatuses` は `useGitStatusStore` の computed（`repoStore` 派生）で、初回 `loadGitStatus()` 完了 / `gitStatusChange` push の両経路で更新される。これを `watch` して `filerEventStore.emitGitStatusChange()` を発火することで、両経路を 1 本のトリガに揃える（初回マウント直後に削除仮想エントリが取りこぼされる race を解消）
- snapshot mode 中はこれらの event を FileTreeItem が無視する（snapshot は不変）
</doc>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onUnmounted, watch } from "vue";
import { onMessage } from "../../shared/rpc";
import { useGitGraphStore } from "../git-graph";
import { UNCOMMITTED_HASH, useGitStatusStore, useWorktreeStore } from "../worktree";
import FileTreeItem from "./FileTreeItem.vue";
import type { FsChangePayload } from "./rpc";
import { useFilerEventStore } from "./useFilerEventStore";

const emit = defineEmits<{
  select: [relPath: string];
}>();

const worktreeStore = useWorktreeStore();
const { dir, selectedRelPath } = storeToRefs(worktreeStore);
const gitStatusStore = useGitStatusStore();
const { gitStatuses } = storeToRefs(gitStatusStore);
const gitGraphStore = useGitGraphStore();
const { selectedHash } = storeToRefs(gitGraphStore);
const filerEventStore = useFilerEventStore();

// git-graph で UNCOMMITTED_HASH 以外の commit が選択されているとき、filer は
// そのコミット時点の全 tree (snapshot) を表示する。compareHash は今回スコープ外で、
// selectedHash 単独で判定する。
const snapshotHash = computed(() =>
  selectedHash.value === UNCOMMITTED_HASH ? undefined : selectedHash.value,
);

// snapshot mode 時は git status を tree に重ねない (過去コミットの tree に対し working tree
// の status を重ねるのは誤情報。例: 「working で削除した path」が過去 commit には存在しているのに
// 削除バッジが出てしまう)。空 map を渡して FileTreeItem 側の git change 計算を無効化する。
const treeGitStatuses = computed(() => (snapshotHash.value === undefined ? gitStatuses.value : {}));

// root FileTreeItem を再マウントするための key。dir と snapshotHash の組で識別し、どちらが
// 変化しても in-flight loadChildren を構造的に破棄する。
const rootKey = computed(() => `${dir.value ?? ""}:${snapshotHash.value ?? ""}`);

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
        :key="rootKey"
        name=""
        path=""
        :is-directory="true"
        :is-ignored="false"
        :git-statuses="treeGitStatuses"
        :snapshot-hash="snapshotHash"
        :depth="-1"
        :selected-rel-path="selectedRelPath"
        @select="(path: string) => emit('select', path)"
      />
    </div>
  </div>
</template>
