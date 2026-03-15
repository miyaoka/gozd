import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";
import { useRpc } from "../rpc/useRpc";
import type { SplitDirection, SplitNode } from "./splitTree";
import {
  collectLeafIds,
  createLeaf,
  removeNode,
  resizeBranch as resizeBranchFn,
  splitNode,
} from "./splitTree";

interface TerminalLayoutState {
  root: SplitNode;
  focusedLeafId: string;
}

interface PaneEntry {
  dir: string;
  ptyId?: number;
}

/**
 * ターミナル分割レイアウトと PTY の状態を管理する。
 * leaf の追加・削除は store の action のみが行う（単一所有者）。
 * コンポーネントの unmount は xterm dispose 等のローカルリソース解放のみ担当する。
 */
export const useTerminalStore = defineStore("terminal", () => {
  const { send } = useRpc();

  /** 訪問済みの worktree ディレクトリ一覧（初回訪問順） */
  const visitedDirs = ref<string[]>([]);

  /** worktree dir → 分割レイアウト状態 */
  const layoutsByDir = ref<Record<string, TerminalLayoutState>>({});

  /** leafId → PTY 対応 + 所属 dir */
  const paneRegistry = ref<Record<string, PaneEntry>>({});

  /** split ドラッグ中の fit 抑制カウンター */
  const dragSuspendCount = ref(0);

  /** layoutsByDir[dir] を返す。未登録なら初期リーフで作成する */
  function ensureLayout(dir: string): TerminalLayoutState {
    const existing = layoutsByDir.value[dir];
    if (existing !== undefined) return existing;

    const leaf = createLeaf();
    const layout: TerminalLayoutState = {
      root: leaf,
      focusedLeafId: leaf.id,
    };
    layoutsByDir.value[dir] = layout;
    paneRegistry.value[leaf.id] = { dir };
    return layout;
  }

  /** worktree を訪問したときに呼ぶ。未登録なら追加する */
  function visit(dir: string) {
    if (!visitedDirs.value.includes(dir)) {
      visitedDirs.value.push(dir);
    }
    ensureLayout(dir);
  }

  /** フォーカス中のリーフを分割する */
  function splitPane(dir: string, direction: SplitDirection) {
    const layout = layoutsByDir.value[dir];
    if (layout === undefined) return;

    const result = splitNode(layout.root, layout.focusedLeafId, direction);
    if (!result.changed) return;

    layoutsByDir.value[dir] = {
      root: result.root,
      focusedLeafId: result.nextFocusedLeafId,
    };

    if (result.createdLeafId !== undefined) {
      paneRegistry.value[result.createdLeafId] = { dir };
    }
  }

  /** ペインを閉じる。削除可否を先に判定してから副作用を実行する */
  function closePane(dir: string, leafId: string) {
    const layout = layoutsByDir.value[dir];
    if (layout === undefined) return;

    // 最後の1リーフや存在しない leafId では changed: false で何もしない
    const result = removeNode(layout.root, leafId);
    if (!result.changed) return;

    // 削除確定後に PTY kill + paneRegistry 削除
    const entry = paneRegistry.value[leafId];
    if (entry?.ptyId !== undefined) {
      send.ptyKill({ id: entry.ptyId });
    }
    delete paneRegistry.value[leafId];

    layoutsByDir.value[dir] = {
      root: result.root,
      focusedLeafId: result.nextFocusedLeafId,
    };
  }

  /** branch の ratio を更新する */
  function resizeBranch(dir: string, branchId: string, ratio: number) {
    const layout = layoutsByDir.value[dir];
    if (layout === undefined) return;

    layoutsByDir.value[dir] = {
      ...layout,
      root: resizeBranchFn(layout.root, branchId, ratio),
    };
  }

  /** フォーカスを変更する */
  function focusPane(leafId: string) {
    const entry = paneRegistry.value[leafId];
    if (entry === undefined) return;

    const layout = layoutsByDir.value[entry.dir];
    if (layout === undefined) return;

    layoutsByDir.value[entry.dir] = {
      ...layout,
      focusedLeafId: leafId,
    };
  }

  /** PTY spawn 完了後に leaf に ptyId を紐付ける */
  function registerPanePty(leafId: string, ptyId: number) {
    const entry = paneRegistry.value[leafId];
    if (entry === undefined) return;
    paneRegistry.value[leafId] = { ...entry, ptyId };
  }

  /** PTY 終了時に ptyId をリセットする。expectedPtyId と一致する場合のみ */
  function clearPanePty(leafId: string, expectedPtyId: number) {
    const entry = paneRegistry.value[leafId];
    if (entry === undefined) return;
    if (entry.ptyId !== expectedPtyId) return;
    paneRegistry.value[leafId] = { ...entry, ptyId: undefined };
  }

  /**
   * worktree 削除時に呼ぶ。
   * 全 leaf の PTY kill → paneRegistry 掃除 → layoutsByDir 削除 → visitedDirs 削除
   */
  function remove(dir: string) {
    const layout = layoutsByDir.value[dir];
    if (layout !== undefined) {
      const leafIds = collectLeafIds(layout.root);
      for (const leafId of leafIds) {
        const entry = paneRegistry.value[leafId];
        if (entry?.ptyId !== undefined) {
          send.ptyKill({ id: entry.ptyId });
        }
        delete paneRegistry.value[leafId];
      }
      delete layoutsByDir.value[dir];
    }

    visitedDirs.value = visitedDirs.value.filter((d) => d !== dir);
  }

  function incrementDragSuspend() {
    dragSuspendCount.value++;
  }

  function decrementDragSuspend() {
    dragSuspendCount.value = Math.max(0, dragSuspendCount.value - 1);
  }

  return {
    visitedDirs,
    layoutsByDir,
    paneRegistry,
    dragSuspendCount,
    ensureLayout,
    visit,
    splitPane,
    closePane,
    resizeBranch,
    focusPane,
    registerPanePty,
    clearPanePty,
    remove,
    incrementDragSuspend,
    decrementDragSuspend,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTerminalStore, import.meta.hot));
}
