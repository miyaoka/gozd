<doc lang="md">
ファイルツリーのルートコンテナ。

## 動作

- worktree の dir が設定されると、worktree 自体を表す不可視ルート FileTreeItem を 1 個描画する
- ツリー全体（ルート直下を含む）の管理は FileTreeItem 側に再帰委譲する
- ルート FileTreeItem は `:key="dir"` で識別する。snapshot mode の切替は子側の `snapshotHash`
  watch で children を invalidate する経路に倒し、再マウントで展開状態を捨てない
- file クリックは `select` emit で親に委譲する（副作用は親側で扱う / ChangesPane と対称）

## snapshot mode

- git-graph で UNCOMMITTED_HASH 以外の commit が選択されているとき、filer は
  「そのコミット時点の全 tree」を表示する snapshot mode に切り替わる
- `snapshotHash` は子に props として流すだけ。git status / fsChange との連動抑止や
  色分け / 削除仮想エントリ抑止は FileTreeItem 側で `snapshotHash` を見て 1 か所で分岐する
- snapshot mode 中にファイルをクリックすると `selectedRelPath` が更新され、preview は
  既存 CommitMode 経路 (`gitShowCommitFile`) で from/to を取得する
- snapshot mode 切替時、選択中ファイルが snapshot tree に存在しないと Filer ハイライトが消え
  Preview は CommitMode の `not_found` 規約で "File not found" を表示する（既存契約）
- snapshot は不変（編集不可）であることを、ツリー背景の read-only surface への切替で伝える
- working tree に戻る "Now" ボタンはヘッダーではなく tree 右上に float させる。フリーズした
  過去（グレー面）の上に脱出口を重ねることで「ここは過去、押すと now」の対比が空間的に伝わる。
  表示条件は `snapshotHash` 単独（commits ウィンドウ未ロードで日時が解決できなくても snapshot
  mode 自体は継続しているため、日時表示の成否と独立して出し続ける）

## selection リセット

- `useGitGraphStore` は worktree 間 singleton。GitGraphPane が unmount される経路
  (non-git project 表示中など) では worktree 切替時に `gitGraphStore.resetSelection()` が
  発火しない。FilerPane 側で `dir` 変化を watch して reset を発火し、別 repo に切り替えた
  瞬間に旧 hash が flying して `rpcGitLsTree` に渡るのを構造的に防ぐ
- GitGraphPane 側の reset と二重発火しても `resetSelection()` は idempotent

## gitStatus / fsChange の購読

- `fsChange` push は `dir` フィルタを通して `filerEventStore.emitFsChange(relDir)` に流す
- `gitStatuses` は `useGitStatusStore` の computed（`repoStore` 派生）で、初回 `loadGitStatus()` 完了 / `gitStatusChange` push の両経路で更新される。これを `watch` して `filerEventStore.emitGitStatusChange()` を発火することで、両経路を 1 本のトリガに揃える（初回マウント直後に削除仮想エントリが取りこぼされる race を解消）
- snapshot mode 中はこれらの event を FileTreeItem が無視する（snapshot は不変）
</doc>

<script setup lang="ts">
import { useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, useTemplateRef, watch } from "vue";
import { useContextKeys } from "../../shared/command";
import { onMessage } from "../../shared/rpc";
import { useGitGraphStore } from "../git-graph";
import type { FileContextMenuPayload } from "../navigator";
import { UNCOMMITTED_HASH, useGitStatusStore, useWorktreeStore } from "../worktree";
import FileTreeItem from "./FileTreeItem.vue";
import type { FsChangePayload } from "./rpc";
import { useFilerEventStore } from "./useFilerEventStore";

// 右クリック menu open 中の操作対象 relPath。menu state の SSOT は navigator の popover
// singleton だが、依存方向 (navigator → 子) を保つため props で受けて FileTreeItem に流す
const props = defineProps<{
  menuTargetRelPath?: string;
}>();

const emit = defineEmits<{
  select: [relPath: string];
  /**
   * ファイル行で contextmenu が発火した時、配下から bubble してくる payload。
   * NavigatorPane が受けて singleton popover を open する。type-only import で navigator
   * から payload 型を持ってくるが、ランタイム依存は無いので 1 方向 (navigator → 子) を保つ。
   */
  contextMenu: [payload: FileContextMenuPayload];
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
// selectedHash 単独で判定する (`gitGraphStore.isSnapshotMode` が SSOT)。
const snapshotHash = computed(() =>
  gitGraphStore.isSnapshotMode ? selectedHash.value : undefined,
);

// filerFocus context key の同期。ツリー行は <button> なのでクリック / Tab でフォーカスが
// 入り、focusin/focusout がコンテナまで bubble する。focusout はツリー内のフォーカス移動
// （行間の移動）でも発火するため、移動先がコンテナ内なら維持する。
const rootRef = useTemplateRef<HTMLElement>("root");
const contextKeys = useContextKeys();
useEventListener(rootRef, "focusin", () => contextKeys.set("filerFocus", true));
useEventListener(rootRef, "focusout", (e: FocusEvent) => {
  const next = e.relatedTarget;
  if (next instanceof Node && rootRef.value?.contains(next)) return;
  contextKeys.set("filerFocus", false);
});
onUnmounted(() => contextKeys.set("filerFocus", false));

// snapshot 表示から working tree (最新 = "Now") に戻す。git-graph の「Working Tree」行
// クリックと同一経路 (user-initiated select、compareHash クリア)。
function goToNow() {
  gitGraphStore.select(UNCOMMITTED_HASH);
}

// dir 切替で git-graph の selection をリセットする。GitGraphPane が unmount される経路
// (MainLayout の v-if で non-git project では mount されない) では GitGraphPane 側の
// dir watch が走らず、別 repo に切り替えた瞬間に旧 hash で snapshotHash computed が成立して
// しまう。FilerPane は常に mount されるためここで fallback として reset を発火する。
watch(dir, () => {
  gitGraphStore.resetSelection();
});

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
  <div
    ref="root"
    class="relative flex size-full flex-col"
    :class="snapshotHash !== undefined ? 'bg-background-readonly' : undefined"
  >
    <!-- ツリー本体 -->
    <div class="flex-1 overflow-y-auto p-1">
      <div v-if="!dir" class="px-2 py-4 text-center text-sm text-foreground-low">
        waiting for open command...
      </div>
      <FileTreeItem
        v-else
        :key="dir"
        name=""
        path=""
        kind="directory"
        :git-statuses="gitStatuses"
        :snapshot-hash="snapshotHash"
        :depth="-1"
        :selected-rel-path="selectedRelPath"
        :menu-target-rel-path="props.menuTargetRelPath"
        @select="(path: string) => emit('select', path)"
        @context-menu="(payload) => emit('contextMenu', payload)"
      />
    </div>
    <!-- snapshot 脱出ボタン。scroll 内に置くと tree と一緒に流れるため、scroll 外の
         sibling として float させる（設計意図は doc ブロック参照） -->
    <button
      v-if="snapshotHash !== undefined"
      type="button"
      class="absolute top-1 right-2 rounded-sm border border-border bg-element-hover px-1.5 py-1 text-xs text-foreground-low hover:bg-element-active hover:text-foreground"
      title="Jump to latest (working tree)"
      @click="goToNow"
    >
      ↑now
    </button>
  </div>
</template>
