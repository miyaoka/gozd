import type { Ref } from "vue";

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

/**
 * Claude Code の状態エントリ。状態と付随データを一体管理する。
 * - lastActivityAt: 最後に Claude が動いた時刻。session-start / running / tool-done /
 *   tool-failure（非 interrupt）/ done / stop-failure で更新。idle（interrupt 含む）/
 *   asking 遷移時は維持する。サイドバーの相対時刻はこれを基準にする。
 */
type ClaudeStatusBase = { lastActivityAt: number };
export type ClaudeStatus =
  | ({ state: "idle" } & ClaudeStatusBase)
  | ({ state: "working" } & ClaudeStatusBase)
  | ({
      state: "asking";
      toolName?: string;
      toolInput?: Record<string, unknown>;
    } & ClaudeStatusBase)
  | ({ state: "done"; message?: string } & ClaudeStatusBase);

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

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/** PermissionRequest の debounce 時間（ms）。この間に tool-done が来たら asking にしない */
const ASK_DEBOUNCE_MS = 150;

/** interrupt パターンマッチ用の定数 */
const INTERRUPT_MARKER = "⎿ \u00A0Interrupted";
const PTY_TAIL_BUFFER_SIZE = 50;

/** paneRegistry の読み取り専用ビュー。claudeStatus が必要とする情報だけを公開する */
interface PaneAccessor {
  /** leafId に対応する session の ptyId を返す。session がなければ undefined */
  getSessionPtyId: (leafId: string) => number | undefined;
  /** 全ペインを走査する。各エントリは leafId, dir, ptyId（session がなければ undefined） */
  iteratePanes: () => Iterable<{ leafId: string; dir: string; ptyId: number | undefined }>;
}

interface ClaudeStatusManagerDeps {
  claudeStatusByPtyId: Ref<Record<number, ClaudeStatus>>;
  panes: PaneAccessor;
  /** ptyId が生存中かどうか */
  isPtyAlive: (ptyId: number) => boolean;
}

export function createClaudeStatusManager(deps: ClaudeStatusManagerDeps) {
  const { claudeStatusByPtyId, panes, isPtyAlive } = deps;

  /** ptyId → PermissionRequest の debounce タイマー */
  const askTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** PTY ごとの直近 tail バッファ。チャンク分割でマーカーが跨いだ場合に備える */
  const ptyTailBuffers = new Map<number, string>();
  /** sessionId ↔ ptyId のマッピング。session-start hook で確立、session-end / cleanup で破棄。
   *  task.id == sessionId の同一視ルール により、task 行から status を引くために使う。 */
  const ptyIdBySessionId = new Map<string, number>();
  const sessionIdByPtyId = new Map<number, string>();

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
    if (!isPtyAlive(ptyId)) return;

    const current = claudeStatusByPtyId.value[ptyId];

    switch (event) {
      case "session-start": {
        cancelAskTimer(ptyId);
        const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
        if (sessionId !== "") {
          // 同 ptyId に旧 sessionId が紐付いていた場合は先に解除する。
          // /clear や /resume で session が切り替わった時、旧 mapping が残ると
          // 別 task のステータスを引いてしまう。
          const previousSessionId = sessionIdByPtyId.get(ptyId);
          if (previousSessionId !== undefined && previousSessionId !== sessionId) {
            ptyIdBySessionId.delete(previousSessionId);
          }
          sessionIdByPtyId.set(ptyId, sessionId);
          ptyIdBySessionId.set(sessionId, ptyId);
        }
        claudeStatusByPtyId.value[ptyId] = { state: "idle", lastActivityAt: Date.now() };
        break;
      }
      case "session-end": {
        cancelAskTimer(ptyId);
        const endingSessionId = typeof payload.session_id === "string" ? payload.session_id : "";
        const currentSessionId = sessionIdByPtyId.get(ptyId);
        // session-start 側と対称な防御: /clear や /resume で session が切り替わった
        // あとに旧 session の session-end が遅延到達した場合、現在 mapping を
        // 誤って消すのを防ぐ。
        if (endingSessionId === "") {
          // Swift 側 hook payload (GozdApp.swift の onHook) は session-start /
          // session-end で必ず sessionId を含む。空文字到達は仕様外なので silent
          // 通過させず観察可能化する。
          console.warn(
            `[claude-status] session-end with empty session_id (ptyId=${ptyId}); ` +
              "falling back to current mapping",
          );
        } else if (endingSessionId !== currentSessionId) {
          ptyIdBySessionId.delete(endingSessionId);
          break;
        }
        if (currentSessionId !== undefined) {
          ptyIdBySessionId.delete(currentSessionId);
          sessionIdByPtyId.delete(ptyId);
        }
        delete claudeStatusByPtyId.value[ptyId];
        break;
      }
      case "running": {
        cancelAskTimer(ptyId);
        claudeStatusByPtyId.value[ptyId] = { state: "working", lastActivityAt: Date.now() };
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
            const prev = claudeStatusByPtyId.value[ptyId];
            // asking は session-start 後にしか発火しない。debounce 中に session-end が
            // 走った場合のみ prev が消える → その時は asking に遷移すべきでないため早期 return。
            if (prev === undefined) return;
            // asking 遷移では lastActivityAt を維持（ユーザー操作待ちの空白時間は活動ではない）
            claudeStatusByPtyId.value[ptyId] = {
              state: "asking",
              lastActivityAt: prev.lastActivityAt,
              toolName,
              toolInput,
            };
          }, ASK_DEBOUNCE_MS),
        );
        break;
      }
      case "tool-failure": {
        cancelAskTimer(ptyId);
        if (payload.is_interrupt === true) {
          // ユーザーが Ctrl+C でツール実行を中断 → プロンプト待ちに戻る。
          // session-start 後にしか発火しないため current は存在する。
          // current が undefined なら session-start 未到達の仕様外イベントなので無視。
          if (current === undefined) return;
          // lastActivityAt は維持（中断はユーザー操作で、Claude の活動ではない）
          claudeStatusByPtyId.value[ptyId] = {
            state: "idle",
            lastActivityAt: current.lastActivityAt,
          };
          break;
        }
        // interrupt でないツール失敗は tool-done と同じ扱い（working 継続）
        if (current?.state === "done") break;
        claudeStatusByPtyId.value[ptyId] = { state: "working", lastActivityAt: Date.now() };
        break;
      }
      case "tool-done": {
        cancelAskTimer(ptyId);
        // done 後の遅延 tool-done を無視（イベント順序逆転対策）
        if (current?.state === "done") break;
        claudeStatusByPtyId.value[ptyId] = { state: "working", lastActivityAt: Date.now() };
        break;
      }
      case "done": {
        cancelAskTimer(ptyId);
        const message =
          typeof payload.last_assistant_message === "string"
            ? payload.last_assistant_message
            : undefined;
        claudeStatusByPtyId.value[ptyId] = {
          state: "done",
          lastActivityAt: Date.now(),
          message,
        };
        break;
      }
      case "stop-failure": {
        // API エラーによる停止。done と同様に人間への通知が必要
        cancelAskTimer(ptyId);
        const message =
          typeof payload.last_assistant_message === "string"
            ? payload.last_assistant_message
            : undefined;
        claudeStatusByPtyId.value[ptyId] = {
          state: "done",
          lastActivityAt: Date.now(),
          message,
        };
        break;
      }
    }
  }

  /**
   * PTY データから interrupt パターンを検知して状態を更新する。
   * Claude Code は Ctrl+C/Escape で中断されると以下を PTY に出力する:
   *   "⎿ \u00A0Interrupted · What should Claude do instead?"
   * しかし interrupt 時にフックは発火しない（Stop も PostToolUseFailure も来ない）。
   * Claude Code にはユーザー中断を通知するフック（UserInterrupt 等）が存在しないため
   * （anthropics/claude-code#9516 で要望中）、PTY 出力のパターンマッチで代替している。
   * Claude Code の UI 変更でこの文字列が変わると壊れるので注意。
   * "⎿"(U+23BF) は Claude Code のツール出力プレフィックス、空白は SP(U+0020) + NBSP(U+00A0)。
   * PTY の data は任意境界で分割されるため、tail バッファと結合してマッチする。
   */
  function detectInterrupt(ptyId: number, data: string) {
    const currentState = claudeStatusByPtyId.value[ptyId]?.state;
    const tail = ptyTailBuffers.get(ptyId) ?? "";
    const combined = tail + data;

    if (currentState !== "working") return;

    if (combined.includes(INTERRUPT_MARKER)) {
      cancelAskTimer(ptyId);
      // 上の `currentState !== "working"` ガードを通過しているので prev は必ず存在する
      const prev = claudeStatusByPtyId.value[ptyId];
      if (prev === undefined) return;
      // interrupt はユーザー操作で Claude の活動ではないので lastActivityAt 維持
      claudeStatusByPtyId.value[ptyId] = { state: "idle", lastActivityAt: prev.lastActivityAt };
    }
    // 直近 PTY_TAIL_BUFFER_SIZE 文字を保持
    ptyTailBuffers.set(ptyId, data.slice(-PTY_TAIL_BUFFER_SIZE));
  }

  /** leafId に対応する Claude Code の状態を返す。未起動（エントリなし）の場合は undefined */
  function getClaudeState(leafId: string): ClaudeState | undefined {
    const ptyId = panes.getSessionPtyId(leafId);
    if (ptyId === undefined) return undefined;
    return claudeStatusByPtyId.value[ptyId]?.state;
  }

  /** Claude セッションが存在する（idle / working / asking / done）leafId 一覧 */
  function getClaudeActiveLeafIds(): string[] {
    const ids: string[] = [];
    for (const pane of panes.iteratePanes()) {
      if (pane.ptyId === undefined) continue;
      if (claudeStatusByPtyId.value[pane.ptyId] !== undefined) {
        ids.push(pane.leafId);
      }
    }
    return ids;
  }

  /** worktree dir に属する全ターミナルの Claude 状態を返す（未起動は除外） */
  function getClaudeStatusesByDir(dir: string): ClaudeStatus[] {
    const statuses: ClaudeStatus[] = [];
    for (const pane of panes.iteratePanes()) {
      if (pane.dir !== dir) continue;
      if (pane.ptyId === undefined) continue;
      const status = claudeStatusByPtyId.value[pane.ptyId];
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
    for (const pane of panes.iteratePanes()) {
      if (pane.dir !== dir) continue;
      if (pane.ptyId === undefined) continue;
      const prev = claudeStatusByPtyId.value[pane.ptyId];
      if (prev?.state === "done") {
        // done → idle (既読消化) では lastActivityAt 維持
        claudeStatusByPtyId.value[pane.ptyId] = {
          state: "idle",
          lastActivityAt: prev.lastActivityAt,
        };
      }
    }
  }

  /** PTY 終了時のクリーンアップ */
  function cleanupPty(ptyId: number) {
    cancelAskTimer(ptyId);
    ptyTailBuffers.delete(ptyId);
    const previousSessionId = sessionIdByPtyId.get(ptyId);
    if (previousSessionId !== undefined) {
      ptyIdBySessionId.delete(previousSessionId);
      sessionIdByPtyId.delete(ptyId);
    }
    delete claudeStatusByPtyId.value[ptyId];
  }

  /** task.id (= sessionId) から ClaudeStatus を引く。session 確立前 / pty 終了後は undefined */
  function getStatusBySessionId(sessionId: string): ClaudeStatus | undefined {
    const ptyId = ptyIdBySessionId.get(sessionId);
    if (ptyId === undefined) return undefined;
    return claudeStatusByPtyId.value[ptyId];
  }

  /** task.id (= sessionId) から live PTY の ptyId を引く。未起動 / 終了済みは undefined */
  function getPtyIdBySessionId(sessionId: string): number | undefined {
    return ptyIdBySessionId.get(sessionId);
  }

  /** ptyId から sessionId (= task.id) を引く。OSC title sync で leaf → task 解決に使う */
  function getSessionIdByPtyId(ptyId: number): string | undefined {
    return sessionIdByPtyId.get(ptyId);
  }

  return {
    handleHookEvent,
    detectInterrupt,
    getClaudeState,
    getClaudeActiveLeafIds,
    getClaudeStatusesByDir,
    getStatusBySessionId,
    getPtyIdBySessionId,
    getSessionIdByPtyId,
    clearDoneStates,
    cleanupPty,
  };
}
