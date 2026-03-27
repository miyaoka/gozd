import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { useContextKeys } from "../../shared/command";
import { useRpc } from "../../shared/rpc";
import type { ClaudeStatus } from "./claudeStatus";
import { isHookEvent, createClaudeStatusManager } from "./claudeStatus";
import { createPtySessionManager } from "./ptySession";
import type { PaneEntry } from "./ptySession";
import { createTerminalLayout } from "./terminalLayout";
import type { TerminalLayoutState } from "./terminalLayout";

/**
 * ターミナル分割レイアウトと PTY の状態を管理する。
 * leaf の追加・削除は store の action のみが行う（単一所有者）。
 * PTY のライフサイクル（spawn/kill/data）も store が一元管理する。
 * コンポーネントは xterm の attach/detach のみ担当する。
 */
export const useTerminalStore = defineStore("terminal", () => {
  const { request, send, onPtyData, onPtyExit, onGozdHook } = useRpc();
  const contextKeys = useContextKeys();

  // --- 共有 state ---

  /** 訪問済みの worktree ディレクトリ一覧（初回訪問順） */
  const visitedDirs = ref<string[]>([]);

  /** worktree dir → 分割レイアウト状態 */
  const layoutsByDir = ref<Record<string, TerminalLayoutState>>({});

  /** leafId → PTY 対応 + 所属 dir */
  const paneRegistry = ref<Record<string, PaneEntry>>({});

  /** split ドラッグ中の fit 抑制カウンター */
  const dragSuspendCount = ref(0);

  /** ターミナル表示モード: wt=アクティブworktreeのみ, all=全leaf, claude=Claude起動中のみ */
  type ViewMode = "wt" | "all" | "claude";
  const viewMode = ref<ViewMode>("wt");

  /** ptyId → Claude Code の状態（idle は undefined = エントリなし） */
  const claudeStatusByPtyId = ref<Record<number, ClaudeStatus>>({});

  /** leafId → PTY の現在の CWD（OSC 7 で更新される） */
  const cwdByLeafId = ref<Record<string, string>>({});

  /** leafId → ターミナルタイトル（OSC 0/2 で更新される） */
  const titleByLeafId = ref<Record<string, string>>({});

  /** 直近のタイトル更新（外部の watch 用シグナル） */
  const lastTitleUpdate = shallowRef<{ leafId: string; title: string }>();

  // --- モジュール初期化 ---

  const ptySession = createPtySessionManager({
    panes: {
      getPane: (leafId) => paneRegistry.value[leafId],
      setSession: (leafId, session) => {
        const entry = paneRegistry.value[leafId];
        if (entry === undefined) return;
        paneRegistry.value[leafId] = { ...entry, session };
      },
      iterateEntries: () => Object.entries(paneRegistry.value),
    },
    requestPtySpawn: request.ptySpawn,
    sendPtyKill: send.ptyKill,
    onDataReceived: (ptyId, data) => claude.detectInterrupt(ptyId, data),
    onPtyCleanup: (ptyId) => claude.cleanupPty(ptyId),
  });

  const claude = createClaudeStatusManager({
    claudeStatusByPtyId,
    panes: {
      getSessionPtyId: (leafId) => paneRegistry.value[leafId]?.session?.ptyId,
      iteratePanes: function* () {
        for (const [leafId, entry] of Object.entries(paneRegistry.value)) {
          yield { leafId, dir: entry.dir, ptyId: entry.session?.ptyId };
        }
      },
    },
    isPtyAlive: ptySession.isPtyAlive,
  });

  const layout = createTerminalLayout({
    layoutsByDir,
    visitedDirs,
    panes: {
      registerPane: (leafId, dir) => {
        paneRegistry.value[leafId] = { dir };
      },
      unregisterPane: (leafId) => {
        ptySession.killPty(leafId);
        delete cwdByLeafId.value[leafId];
        delete titleByLeafId.value[leafId];
        delete paneRegistry.value[leafId];
      },
      getPaneDir: (leafId) => paneRegistry.value[leafId]?.dir,
      getLeafIdsByDir: (dir) =>
        Object.entries(paneRegistry.value)
          .filter(([, entry]) => entry.dir === dir)
          .map(([leafId]) => leafId),
    },
    resetTerminalFocus: () => contextKeys.set("terminalFocus", false),
  });

  // --- computed ---

  /** Claude セッションが存在する（idle / working / asking / done）leafId 一覧 */
  const claudeActiveLeafIds = computed(() => claude.getClaudeActiveLeafIds());

  // --- RPC 購読 ---

  /** HMR 再実行時に前回のリスナーを解除するための disposer */
  let disposeDataListener: (() => void) | undefined;
  let disposeExitListener: (() => void) | undefined;
  let disposeHookListener: (() => void) | undefined;

  function initSubscriptions() {
    disposeDataListener?.();
    disposeExitListener?.();
    disposeHookListener?.();

    // HMR で Map が再初期化されるため、paneRegistry から逆引きを復元
    ptySession.rebuildPtyIdMap();

    disposeDataListener = onPtyData(({ id, data }) => {
      ptySession.handlePtyData(id, data);
    });

    disposeExitListener = onPtyExit(({ id }) => {
      ptySession.handlePtyExit(id);
    });

    disposeHookListener = onGozdHook(({ event, payload }) => {
      const ptyId = typeof payload.ptyId === "number" ? payload.ptyId : undefined;
      if (ptyId === undefined) return;
      if (!isHookEvent(event)) return;
      claude.handleHookEvent(ptyId, event, payload);
    });
  }

  initSubscriptions();

  // --- pane getter ---

  /** leafId に対応するペーンの dir を返す */
  function getPaneDir(leafId: string): string | undefined {
    return paneRegistry.value[leafId]?.dir;
  }

  /** leafId に対応する PTY の ptyId を返す */
  function getPtyId(leafId: string): number | undefined {
    return paneRegistry.value[leafId]?.session?.ptyId;
  }

  // --- CWD ---

  /** OSC 7 で通知された CWD を保存する */
  function setCwd(leafId: string, cwd: string) {
    cwdByLeafId.value[leafId] = cwd;
  }

  /** OSC 0/2 で通知されたタイトルを保存する */
  function setTitle(leafId: string, title: string) {
    if (title === "") {
      delete titleByLeafId.value[leafId];
    } else {
      titleByLeafId.value[leafId] = title;
    }
    lastTitleUpdate.value = { leafId, title };
  }

  // --- drag suspend ---

  function incrementDragSuspend() {
    dragSuspendCount.value++;
  }

  function decrementDragSuspend() {
    dragSuspendCount.value = Math.max(0, dragSuspendCount.value - 1);
  }

  return {
    // state
    visitedDirs,
    layoutsByDir,
    dragSuspendCount,
    viewMode,
    cwdByLeafId,
    titleByLeafId,
    lastTitleUpdate,
    // computed
    claudeActiveLeafIds,
    // layout
    visit: layout.visit,
    splitPane: layout.splitPane,
    closePane: layout.closePane,
    resetLayout: layout.resetLayout,
    resizeBranch: layout.resizeBranch,
    focusPane: layout.focusPane,
    remove: layout.remove,
    // pty
    spawnPty: ptySession.spawnPty,
    killPty: ptySession.killPty,
    attachTerminal: ptySession.attachTerminal,
    // claude
    getClaudeState: claude.getClaudeState,
    getClaudeStatusesByDir: claude.getClaudeStatusesByDir,
    clearDoneStates: claude.clearDoneStates,
    // pane getter
    getPaneDir,
    getPtyId,
    // cwd
    setCwd,
    // title
    setTitle,
    // drag
    incrementDragSuspend,
    decrementDragSuspend,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTerminalStore, import.meta.hot));
}
