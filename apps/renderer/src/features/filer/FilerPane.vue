<script setup lang="ts">
import type { FsChangePayload } from "@gozd/rpc";
import { useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, useTemplateRef, watch } from "vue";
import { useContextKeys } from "../../shared/command";
import { onMessage } from "../../shared/rpc";
import { useGitGraphStore } from "../git-graph";
import { UNCOMMITTED_HASH, useGitStatusStore, useWorktreeStore } from "../worktree";
import type { FileContextMenuPayload } from "./fileContextMenuPayload";
import FileTreeItem from "./FileTreeItem.vue";
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
//
// アプリ (window) 切替の再同期 fallback（window "focus" / visibilitychange で
// document.activeElement から復元する類）は不要。Chromium の FocusController は
// window 非アクティブ化時も DOM のフォーカス位置を保持したまま focused element に
// blur/focusout を、再アクティブ化時に同じ要素へ focus/focusin を再 dispatch するため
// （focus_controller.cc の DispatchEventsOnWindowAndFocusedElement、FocusType::kPage）、
// この focusin/focusout 購読だけで filerFocus は実フォーカスに追従する。HTML spec は
// この挙動を規定しない implementation-defined 領域だが、Electron 同梱 Chromium 前提の
// アプリなので依存してよい（Cmd+Tab 復帰後のコピー動作は実機確認済み）。
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
         sibling として float させる -->
    <button
      v-if="snapshotHash !== undefined"
      type="button"
      class="absolute top-1 right-2 rounded-sm border border-border bg-element px-1.5 py-1 text-xs text-foreground-low hover:bg-element-hover hover:text-foreground"
      title="Jump to latest (working tree)"
      @click="goToNow"
    >
      ↑now
    </button>
  </div>
</template>
