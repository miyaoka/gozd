import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";
import { useContextKeys } from "../command/useContextKeys";
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

/** PTY セッション。store が所有し、コンポーネントの mount/unmount を跨いで維持される */
interface PtySession {
  ptyId: number;
  /** 出力 ring buffer。replay 時に xterm.write() で流す */
  chunks: string[];
  /** 書き込み済み総チャンク数（ring buffer のインデックス計算用） */
  totalChunks: number;
  /** PTY 終了済みか */
  exited: boolean;
}

interface PaneEntry {
  dir: string;
  session?: PtySession;
}

/** ring buffer の容量。xterm のデフォルト scrollback（1000行）と同等 */
const PTY_RING_BUFFER_CAPACITY = 1000;

/**
 * ターミナル分割レイアウトと PTY の状態を管理する。
 * leaf の追加・削除は store の action のみが行う（単一所有者）。
 * PTY のライフサイクル（spawn/kill/data）も store が一元管理する。
 * コンポーネントは xterm の attach/detach のみ担当する。
 */
export const useTerminalStore = defineStore("terminal", () => {
  const { request, send, onPtyData, onPtyExit } = useRpc();
  const contextKeys = useContextKeys();

  /** 訪問済みの worktree ディレクトリ一覧（初回訪問順） */
  const visitedDirs = ref<string[]>([]);

  /** worktree dir → 分割レイアウト状態 */
  const layoutsByDir = ref<Record<string, TerminalLayoutState>>({});

  /** leafId → PTY 対応 + 所属 dir */
  const paneRegistry = ref<Record<string, PaneEntry>>({});

  /** split ドラッグ中の fit 抑制カウンター */
  const dragSuspendCount = ref(0);

  // --- PTY セッション管理（非公開状態） ---

  /** leafId → xterm.write コールバック。attach 中のみ存在 */
  const terminalWriters = new Map<string, (data: string) => void>();

  /** ptyId → leafId 逆引き（onPtyData/onPtyExit で高速検索用） */
  const ptyIdToLeafId = new Map<number, string>();

  // --- PTY データの一括購読 ---

  /** HMR 再実行時に前回のリスナーを解除するための disposer */
  let disposeDataListener: (() => void) | undefined;
  let disposeExitListener: (() => void) | undefined;

  function initPtySubscription() {
    disposeDataListener?.();
    disposeExitListener?.();

    disposeDataListener = onPtyData(({ id, data }) => {
      const leafId = ptyIdToLeafId.get(id);
      if (leafId === undefined) return;
      const entry = paneRegistry.value[leafId];
      if (entry?.session === undefined) return;

      // ring buffer に追記
      const session = entry.session;
      const idx = session.totalChunks % PTY_RING_BUFFER_CAPACITY;
      session.chunks[idx] = data;
      session.totalChunks++;

      // attach 中の terminal に即時転送
      const writer = terminalWriters.get(leafId);
      if (writer !== undefined) writer(data);
    });

    disposeExitListener = onPtyExit(({ id, exitCode: _exitCode }) => {
      const leafId = ptyIdToLeafId.get(id);
      if (leafId === undefined) return;
      const entry = paneRegistry.value[leafId];
      if (entry?.session === undefined) return;

      const session = entry.session;
      session.exited = true;

      // ring buffer に終了メッセージを追記
      const exitMsg = "\r\n[Process exited]\r\n";
      const idx = session.totalChunks % PTY_RING_BUFFER_CAPACITY;
      session.chunks[idx] = exitMsg;
      session.totalChunks++;

      const writer = terminalWriters.get(leafId);
      if (writer !== undefined) writer(exitMsg);

      ptyIdToLeafId.delete(id);
    });
  }

  initPtySubscription();

  // --- PTY ライフサイクル関数 ---

  /** PTY を spawn する。既存 session があれば何もしない */
  async function spawnPty(leafId: string, cols: number, rows: number): Promise<void> {
    const entry = paneRegistry.value[leafId];
    if (entry === undefined) return;
    // 既存 session があればスキップ（HMR 再マウント時）
    if (entry.session !== undefined) return;

    const ptyId = await request.ptySpawn({ dir: entry.dir, cols, rows });

    // spawn 完了前に leaf が削除されていたら即 kill
    const current = paneRegistry.value[leafId];
    if (current === undefined) {
      send.ptyKill({ id: ptyId });
      return;
    }

    const session: PtySession = {
      ptyId,
      chunks: Array.from<string>({ length: PTY_RING_BUFFER_CAPACITY }),
      totalChunks: 0,
      exited: false,
    };

    paneRegistry.value[leafId] = { ...current, session };
    ptyIdToLeafId.set(ptyId, leafId);
  }

  /** PTY を kill し、関連リソースをクリーンアップする */
  function killPty(leafId: string) {
    const entry = paneRegistry.value[leafId];
    if (entry?.session === undefined) return;

    send.ptyKill({ id: entry.session.ptyId });
    ptyIdToLeafId.delete(entry.session.ptyId);
    terminalWriters.delete(leafId);
    paneRegistry.value[leafId] = { ...entry, session: undefined };
  }

  /**
   * terminal を PTY セッションに接続する。
   * 既存 session の ring buffer を replay し、以降のデータを即時転送する。
   * @returns detach 用の disposer
   */
  function attachTerminal(leafId: string, writer: (data: string) => void): () => void {
    const entry = paneRegistry.value[leafId];
    if (entry?.session !== undefined) {
      // ring buffer replay
      const session = entry.session;
      const stored = Math.min(session.totalChunks, PTY_RING_BUFFER_CAPACITY);
      const startIdx = session.totalChunks - stored;
      for (let i = startIdx; i < session.totalChunks; i++) {
        writer(session.chunks[i % PTY_RING_BUFFER_CAPACITY]);
      }
    }

    terminalWriters.set(leafId, writer);

    return () => {
      terminalWriters.delete(leafId);
    };
  }

  // --- レイアウト管理 ---

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

  /**
   * ペインを閉じる。削除可否を先に判定してから副作用を実行する。
   * @returns 実際に閉じた場合 true。最後の1リーフ等で閉じられなかった場合 false
   */
  function closePane(dir: string, leafId: string): boolean {
    const layout = layoutsByDir.value[dir];
    if (layout === undefined) return false;

    // 最後の1リーフや存在しない leafId では changed: false で何もしない
    const result = removeNode(layout.root, leafId);
    if (!result.changed) return false;

    // フォーカス中のペインを閉じる場合、unmount より先に terminalFocus をリセット
    if (leafId === layout.focusedLeafId) {
      contextKeys.set("terminalFocus", false);
    }

    // 削除確定後に PTY kill + paneRegistry 削除
    killPty(leafId);
    delete paneRegistry.value[leafId];

    layoutsByDir.value[dir] = {
      root: result.root,
      focusedLeafId: result.nextFocusedLeafId,
    };

    return true;
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

  /**
   * worktree 削除時に呼ぶ。
   * 全 leaf の PTY kill → paneRegistry 掃除 → layoutsByDir 削除 → visitedDirs 削除
   */
  function remove(dir: string) {
    const layout = layoutsByDir.value[dir];
    if (layout !== undefined) {
      const leafIds = collectLeafIds(layout.root);
      for (const leafId of leafIds) {
        killPty(leafId);
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
    spawnPty,
    killPty,
    attachTerminal,
    remove,
    incrementDragSuspend,
    decrementDragSuspend,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTerminalStore, import.meta.hot));
}
