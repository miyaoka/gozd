import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { useContextKeys } from "../../shared/command";
import { useRpc } from "../../shared/rpc";
import type { SplitDirection, SplitNode } from "./splitTree";
import {
  collectLeafIds,
  createLeaf,
  removeNode,
  resizeBranch as resizeBranchFn,
  splitNode,
} from "./splitTree";
import { terminalConfig } from "./terminalConfig";

/**
 * Claude Code の状態。
 * - idle: セッション開始済みだがプロンプト待ち（通知不要）
 * - working: エージェントが作業中（UserPromptSubmit / PostToolUse）
 * - asking: 承認待ち（PermissionRequest）— ユーザー操作が必要
 * - done: 応答完了（Stop）— 人間の確認・入力待ち（通知が必要）
 *
 * undefined（エントリなし）= Claude 未起動
 */
export type ClaudeState = "idle" | "working" | "asking" | "done";

/** Claude Code の状態エントリ。状態と付随データを一体管理する */
export type ClaudeStatus =
  | { state: "idle" }
  | { state: "working"; startedAt: number }
  | { state: "asking"; toolName?: string; toolInput?: Record<string, unknown> }
  | { state: "done"; message?: string };

/**
 * hooks イベント種別。
 * - session-start: SessionStart（セッション開始）
 * - session-end: SessionEnd（セッション終了）
 * - running: UserPromptSubmit（プロンプト送信）
 * - needs-input: PermissionRequest（承認ダイアログ表示）
 * - done: Stop（応答完了）
 * - tool-done: PostToolUse（ツール実行完了）
 * - tool-failure: PostToolUseFailure（ツール実行失敗。is_interrupt で中断判定）
 * - stop-failure: StopFailure（API エラーによる停止）
 */
type HookEvent =
  | "session-start"
  | "session-end"
  | "running"
  | "needs-input"
  | "done"
  | "tool-done"
  | "tool-failure"
  | "stop-failure";

const HOOK_EVENTS: readonly HookEvent[] = [
  "session-start",
  "session-end",
  "running",
  "needs-input",
  "done",
  "tool-done",
  "tool-failure",
  "stop-failure",
];

function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/** PermissionRequest の debounce 時間（ms）。この間に tool-done が来たら asking にしない */
const ASK_DEBOUNCE_MS = 150;

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

/** ring buffer の容量（チャンク数）。scrollback（行数）とは単位が異なるが、十分な再生データを保持する目安として同じ値を使う */
const PTY_RING_BUFFER_CAPACITY = terminalConfig.scrollback;

/**
 * ターミナル分割レイアウトと PTY の状態を管理する。
 * leaf の追加・削除は store の action のみが行う（単一所有者）。
 * PTY のライフサイクル（spawn/kill/data）も store が一元管理する。
 * コンポーネントは xterm の attach/detach のみ担当する。
 */
export const useTerminalStore = defineStore("terminal", () => {
  const { request, send, onPtyData, onPtyExit, onGozdHook } = useRpc();
  const contextKeys = useContextKeys();

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

  /** ptyId → PermissionRequest の debounce タイマー */
  const askTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** interrupt パターンマッチ用の定数 */
  const INTERRUPT_MARKER = "⎿ \u00A0Interrupted";
  /** PTY ごとの直近 tail バッファ。チャンク分割でマーカーが跨いだ場合に備える */
  const ptyTailBuffers = new Map<number, string>();
  const PTY_TAIL_BUFFER_SIZE = 50;

  /** pending ask タイマーをキャンセルする */
  function cancelAskTimer(ptyId: number) {
    const timer = askTimers.get(ptyId);
    if (timer !== undefined) {
      clearTimeout(timer);
      askTimers.delete(ptyId);
    }
  }

  /**
   * hooks イベントを受けて Claude 状態を更新する。
   * PermissionRequest は debounce し、一瞬で通過するケース（自動承認）を除外する。
   * done 後の遅延 tool-done（イベント順序逆転）は無視する。
   */
  function handleHookEvent(ptyId: number, event: HookEvent, payload: Record<string, unknown>) {
    // kill/exit 済みの PTY への遅延イベントを無視
    if (!ptyIdToLeafId.has(ptyId)) return;

    const current = claudeStatusByPtyId.value[ptyId];

    switch (event) {
      case "session-start": {
        cancelAskTimer(ptyId);
        claudeStatusByPtyId.value[ptyId] = { state: "idle" };
        break;
      }
      case "session-end": {
        cancelAskTimer(ptyId);
        delete claudeStatusByPtyId.value[ptyId];
        break;
      }
      case "running": {
        cancelAskTimer(ptyId);
        // 初回 working 遷移時のみ開始時刻を記録（tool-done → working の再遷移では維持）
        const startedAt = current?.state === "working" ? current.startedAt : Date.now();
        claudeStatusByPtyId.value[ptyId] = { state: "working", startedAt };
        break;
      }
      case "needs-input": {
        const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
        const toolInput =
          typeof payload.tool_input === "object" && payload.tool_input !== null
            ? (payload.tool_input as Record<string, unknown>)
            : undefined;
        // debounce: タイマー満了まで asking にしない
        cancelAskTimer(ptyId);
        askTimers.set(
          ptyId,
          setTimeout(() => {
            askTimers.delete(ptyId);
            claudeStatusByPtyId.value[ptyId] = { state: "asking", toolName, toolInput };
          }, ASK_DEBOUNCE_MS),
        );
        break;
      }
      case "tool-failure": {
        cancelAskTimer(ptyId);
        if (payload.is_interrupt === true) {
          // ユーザーが Ctrl+C でツール実行を中断 → プロンプト待ちに戻る
          claudeStatusByPtyId.value[ptyId] = { state: "idle" };
          break;
        }
        // interrupt でないツール失敗は tool-done と同じ扱い（working 継続）
        if (current?.state === "done") break;
        const sf = current?.state === "working" ? current.startedAt : Date.now();
        claudeStatusByPtyId.value[ptyId] = { state: "working", startedAt: sf };
        break;
      }
      case "tool-done": {
        cancelAskTimer(ptyId);
        // done 後の遅延 tool-done を無視（イベント順序逆転対策）
        if (current?.state === "done") break;
        const startedAt = current?.state === "working" ? current.startedAt : Date.now();
        claudeStatusByPtyId.value[ptyId] = { state: "working", startedAt };
        break;
      }
      case "done": {
        cancelAskTimer(ptyId);
        const message =
          typeof payload.last_assistant_message === "string"
            ? payload.last_assistant_message
            : undefined;
        claudeStatusByPtyId.value[ptyId] = { state: "done", message };
        break;
      }
      case "stop-failure": {
        // API エラーによる停止。done と同様に人間への通知が必要
        cancelAskTimer(ptyId);
        const message =
          typeof payload.last_assistant_message === "string"
            ? payload.last_assistant_message
            : undefined;
        claudeStatusByPtyId.value[ptyId] = { state: "done", message };
        break;
      }
    }
  }

  // --- PTY セッション管理（非公開状態） ---

  /** leafId → xterm.write コールバック。attach 中のみ存在 */
  const terminalWriters = new Map<string, (data: string) => void>();

  /** ptyId → leafId 逆引き（onPtyData/onPtyExit で高速検索用） */
  const ptyIdToLeafId = new Map<number, string>();

  /** spawn 中の leafId（二重 spawn 防止） */
  const spawningLeafIds = new Set<string>();

  // --- PTY データの一括購読 ---

  /** HMR 再実行時に前回のリスナーを解除するための disposer */
  let disposeDataListener: (() => void) | undefined;
  let disposeExitListener: (() => void) | undefined;

  /**
   * paneRegistry から ptyIdToLeafId を再構築する。
   * HMR 時に plain Map が空になるため、Pinia state として残っている
   * paneRegistry の session 情報から逆引きを復元する。
   */
  function rebuildPtyIdMap() {
    ptyIdToLeafId.clear();
    for (const [leafId, entry] of Object.entries(paneRegistry.value)) {
      if (entry.session === undefined) continue;
      if (entry.session.exited) continue;
      ptyIdToLeafId.set(entry.session.ptyId, leafId);
    }
  }

  function initPtySubscription() {
    disposeDataListener?.();
    disposeExitListener?.();

    // HMR で Map が再初期化されるため、paneRegistry から逆引きを復元
    rebuildPtyIdMap();

    disposeDataListener = onPtyData(({ id, data }) => {
      const leafId = ptyIdToLeafId.get(id);
      if (leafId === undefined) return;
      const entry = paneRegistry.value[leafId];
      if (entry?.session === undefined) return;

      // --- interrupt 検知（マジックストリングによる PTY 出力パターンマッチ） ---
      // Claude Code は Ctrl+C/Escape で中断されると以下を PTY に出力する:
      //   "⎿ \u00A0Interrupted · What should Claude do instead?"
      // しかし interrupt 時にフックは発火しない（Stop も PostToolUseFailure も来ない）。
      // Claude Code にはユーザー中断を通知するフック（UserInterrupt 等）が存在しないため
      // （anthropics/claude-code#9516 で要望中）、PTY 出力のパターンマッチで代替している。
      // Claude Code の UI 変更でこの文字列が変わると壊れるので注意。
      // "⎿"(U+23BF) は Claude Code のツール出力プレフィックス、空白は SP(U+0020) + NBSP(U+00A0)。
      // PTY の data は任意境界で分割されるため、tail バッファと結合してマッチする。
      if (claudeStatusByPtyId.value[id]?.state === "working") {
        const tail = ptyTailBuffers.get(id) ?? "";
        if ((tail + data).includes(INTERRUPT_MARKER)) {
          cancelAskTimer(id);
          claudeStatusByPtyId.value[id] = { state: "idle" };
        }
        // 直近 PTY_TAIL_BUFFER_SIZE 文字を保持
        ptyTailBuffers.set(id, data.slice(-PTY_TAIL_BUFFER_SIZE));
      }

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
      cancelAskTimer(id);
      ptyTailBuffers.delete(id);
      delete claudeStatusByPtyId.value[id];
    });
  }

  initPtySubscription();

  // --- Claude Code Hook 購読 ---

  let disposeHookListener: (() => void) | undefined;

  function initHookSubscription() {
    disposeHookListener?.();
    disposeHookListener = onGozdHook(({ event, payload }) => {
      const ptyId = typeof payload.ptyId === "number" ? payload.ptyId : undefined;
      if (ptyId === undefined) return;

      if (!isHookEvent(event)) return;

      handleHookEvent(ptyId, event, payload);
    });
  }

  initHookSubscription();

  /** leafId に対応する Claude Code の状態を返す。未起動（エントリなし）の場合は undefined */
  function getClaudeState(leafId: string): ClaudeState | undefined {
    const entry = paneRegistry.value[leafId];
    if (entry?.session === undefined) return undefined;
    return claudeStatusByPtyId.value[entry.session.ptyId]?.state;
  }

  /** Claude セッションが存在する（idle / working / asking / done）leafId 一覧 */
  const claudeActiveLeafIds = computed(() => {
    const ids: string[] = [];
    for (const [leafId, entry] of Object.entries(paneRegistry.value)) {
      if (entry.session === undefined) continue;
      if (claudeStatusByPtyId.value[entry.session.ptyId] !== undefined) {
        ids.push(leafId);
      }
    }
    return ids;
  });

  /** OSC 7 で通知された CWD を保存する */
  function setCwd(leafId: string, cwd: string) {
    cwdByLeafId.value[leafId] = cwd;
  }

  /** worktree dir に属する全ターミナルの Claude 状態を返す（未起動は除外） */
  function getClaudeStatusesByDir(dir: string): ClaudeStatus[] {
    const statuses: ClaudeStatus[] = [];
    for (const paneEntry of Object.values(paneRegistry.value)) {
      if (paneEntry.dir !== dir) continue;
      if (paneEntry.session === undefined) continue;
      const status = claudeStatusByPtyId.value[paneEntry.session.ptyId];
      if (status !== undefined) {
        statuses.push(status);
      }
    }
    return statuses;
  }

  /**
   * worktree dir に属する done 状態を idle に遷移する。
   * フォーカス時の既読消化に使う。Claude セッションは生きているため idle へ。
   */
  function clearDoneStates(dir: string) {
    for (const entry of Object.values(paneRegistry.value)) {
      if (entry.dir !== dir) continue;
      if (entry.session === undefined) continue;
      if (claudeStatusByPtyId.value[entry.session.ptyId]?.state === "done") {
        claudeStatusByPtyId.value[entry.session.ptyId] = { state: "idle" };
      }
    }
  }

  // --- PTY ライフサイクル関数 ---

  /** PTY を spawn する。生存中 session または spawn 中であれば何もしない */
  async function spawnPty(leafId: string, cols: number, rows: number): Promise<void> {
    const entry = paneRegistry.value[leafId];
    if (entry === undefined) return;
    // 生存中 session があればスキップ（HMR 再マウント時）
    // exited session は再 spawn を許可する
    if (entry.session !== undefined && !entry.session.exited) return;
    // 二重 spawn 防止（await 中に再マウントされた場合）
    if (spawningLeafIds.has(leafId)) return;

    spawningLeafIds.add(leafId);
    const result = await tryCatch(request.ptySpawn({ dir: entry.dir, cols, rows }));
    spawningLeafIds.delete(leafId);

    if (!result.ok) {
      console.warn("[terminal] ptySpawn failed:", result.error);
      return;
    }

    const ptyId = result.value;

    // spawn 完了前に leaf が削除されていたら即 kill
    const current = paneRegistry.value[leafId];
    if (current === undefined) {
      send.ptyKill({ id: ptyId });
      return;
    }

    // 別の spawn が先に完了して生存中 session を設定していた場合は即 kill
    if (current.session !== undefined && !current.session.exited) {
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
    cancelAskTimer(entry.session.ptyId);
    ptyTailBuffers.delete(entry.session.ptyId);
    delete claudeStatusByPtyId.value[entry.session.ptyId];
    delete cwdByLeafId.value[leafId];
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

    // disposer は自分が登録した writer のみを削除する（HMR で新旧が入れ替わるため）
    return () => {
      if (terminalWriters.get(leafId) === writer) {
        terminalWriters.delete(leafId);
      }
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

    // 削除確定後に PTY kill + paneRegistry / CWD 削除
    killPty(leafId);
    delete paneRegistry.value[leafId];
    delete cwdByLeafId.value[leafId];

    layoutsByDir.value[dir] = {
      root: result.root,
      focusedLeafId: result.nextFocusedLeafId,
    };

    return true;
  }

  /**
   * レイアウトをリセットする。現在のPTYをすべてkillし、新しい単一リーフで再構築する。
   * 最後の1ペインを閉じて新ターミナルを開く用途で使う。
   */
  function resetLayout(dir: string) {
    const layout = layoutsByDir.value[dir];
    if (layout === undefined) return;

    // 既存の全ペインを破棄
    for (const [leafId, entry] of Object.entries(paneRegistry.value)) {
      if (entry.dir !== dir) continue;
      killPty(leafId);
      delete paneRegistry.value[leafId];
    }

    contextKeys.set("terminalFocus", false);

    // 新しい単一リーフで再構築
    const leaf = createLeaf();
    layoutsByDir.value[dir] = {
      root: leaf,
      focusedLeafId: leaf.id,
    };
    paneRegistry.value[leaf.id] = { dir };
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
        delete cwdByLeafId.value[leafId];
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
    viewMode,
    claudeActiveLeafIds,
    ensureLayout,
    visit,
    splitPane,
    closePane,
    resetLayout,
    resizeBranch,
    focusPane,
    spawnPty,
    killPty,
    attachTerminal,
    remove,
    incrementDragSuspend,
    decrementDragSuspend,
    cwdByLeafId,
    setCwd,
    getClaudeState,
    getClaudeStatusesByDir,
    clearDoneStates,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTerminalStore, import.meta.hot));
}
