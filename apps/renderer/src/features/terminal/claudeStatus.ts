import { tryCatch } from "@gozd/shared";
import { ref, type FunctionalComponent, type Ref, type SVGAttributes } from "vue";
import IconLucideCircleCheck from "~icons/lucide/circle-check";
import IconLucideCircleEllipsis from "~icons/lucide/circle-ellipsis";
import IconLucideLoader from "~icons/lucide/loader";
import IconLucideMessageCircleWarning from "~icons/lucide/message-circle-warning";

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

/** Claude state ごとの形 (icon) と動き (animate)。`CLAUDE_STATE_VISUAL` の構築元（module 内専用） */
const CLAUDE_STATE_ICON: Record<
  ClaudeState,
  { icon: FunctionalComponent<SVGAttributes>; animate?: string }
> = {
  idle: { icon: IconLucideCircleEllipsis },
  working: { icon: IconLucideLoader, animate: "animate-spin" },
  asking: { icon: IconLucideMessageCircleWarning },
  done: { icon: IconLucideCircleCheck },
};

export interface ClaudeStateVisual {
  icon: FunctionalComponent<SVGAttributes>;
  /** 色 + glow を束ねた Tailwind class。状態の緊急度を色と発光で示す */
  color: string;
  animate?: string;
  ariaLabel: string;
  /** 行下端を走る indeterminate progress スキャンライン (`_fx-progress-line`) を出すか */
  progress?: true;
}

/**
 * Claude state の完全な視覚定義 (形 + 色 + glow + animate + aria-label) の SSOT。
 * サイドバー TaskRow とターミナル leaf タイトルが**同一の見た目**を共有するため、
 * 色 / glow / aria-label までここに一元化する。形 (icon / animate) は `CLAUDE_STATE_ICON`
 * から継ぐ。asking のみ pulse を上乗せして承認待ちの緊急度を強調する。
 */
export const CLAUDE_STATE_VISUAL: Record<ClaudeState, ClaudeStateVisual> = {
  asking: {
    ...CLAUDE_STATE_ICON.asking,
    color: "text-warning-strong-text _fx-glow-alert",
    animate: "animate-pulse",
    ariaLabel: "Awaiting permission",
  },
  working: {
    ...CLAUDE_STATE_ICON.working,
    color: "text-warning-text _fx-glow-warning",
    ariaLabel: "Working",
    progress: true,
  },
  done: {
    ...CLAUDE_STATE_ICON.done,
    color: "text-success-text _fx-glow-success",
    ariaLabel: "Done",
  },
  idle: {
    ...CLAUDE_STATE_ICON.idle,
    color: "text-foreground-low",
    ariaLabel: "Idle",
  },
};

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
  | ({ state: "done"; message?: string; pendingWork?: boolean } & ClaudeStatusBase);

/**
 * 表示用の state。`done` かつ `pendingWork`（Stop 発火時に background_tasks /
 * session_crons が残る = 裏で作業継続中）は「真の done」ではないため `working` として
 * 描画する。状態機械上は必ず `done` を経由するので `clearDoneStates`（フォーカス時の
 * 既読消化）で消化でき、状態固着しない。緑バッジ・吹き出し・通知の抑止は表示層が
 * この関数経由で行う。
 */
export function displayClaudeState(status: ClaudeStatus | undefined): ClaudeState | undefined {
  if (status === undefined) return undefined;
  if (status.state === "done" && status.pendingWork === true) return "working";
  return status.state;
}

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
export type HookEvent =
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

/**
 * Claude hook の `tool_input` を構造化オブジェクトにする。proto3 の string 制約により
 * boundary までは JSON 文字列で運ばれる（CLI が object → JSON 文字列にシリアライズする）。
 * ここで 1 度だけ parse することで、`extractAskingText` 等の object 判定が初めて成立する。
 * 既に object のケース（テスト等）はそのまま通し、parse 失敗・非 object は undefined にする。
 */
function parseToolInput(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw === "") return undefined;
  const result = tryCatch(() => JSON.parse(raw) as unknown);
  if (!result.ok) return undefined;
  const parsed = result.value;
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * 音・演出・読み上げの「効果」を駆動する正規化イベント。terminal が hook を 1 度だけ解釈した
 * 結果として発行する (`dispatchMessage("claudeFx", ...)`)。効果を出すべきでない hook
 * (pending work が残る done = 裏で作業継続中 / dead PTY 等) はここで `undefined` に潰されるので、
 * このストリームを購読する側 (voicevox / arcade) は pending を意識せず受け取るだけでよい。
 * 「done を完了扱いするか」の判断を購読者ごとに散らさず、解釈点 1 箇所に集約するための型。
 */
export interface ClaudeFxEvent {
  ptyId: number;
  event: HookEvent;
  /** done / stop-failure の last_assistant_message */
  message?: string;
  /** needs-input の tool 情報 */
  toolName?: string;
  toolInput?: unknown;
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
  /**
   * session-start hook で sessionId ↔ ptyId が確立した瞬間に呼ばれる。
   * resume の連打ガード (pendingResumeByLeafId) を session-start で消化するために使う。
   */
  onSessionAttached?: (ptyId: number, sessionId: string) => void;
}

export function createClaudeStatusManager(deps: ClaudeStatusManagerDeps) {
  const { claudeStatusByPtyId, panes, isPtyAlive, onSessionAttached } = deps;

  /** ptyId → PermissionRequest の debounce タイマー */
  const askTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** PTY ごとの直近 tail バッファ。チャンク分割でマーカーが跨いだ場合に備える */
  const ptyTailBuffers = new Map<number, string>();
  /** sessionId ↔ ptyId のマッピング。session-start hook で確立、session-end / cleanup で破棄。
   *  WtCard / SidebarPane が `task.sessionId` 経由でこの map を引いて、task 行から live PTY や
   *  ClaudeStatus を解決するために使う。
   *
   *  ref<Record> で保持し、key の add/delete を reactivity に乗せる。これにより
   *  `getSessionIdByPtyId(ptyId)` 等を computed から呼ぶだけで session-start / session-end
   *  に追随して再評価される。プロジェクト規約 (issue #501) で `reactive` は禁止なので
   *  Map ではなく Object を使う。 */
  const ptyIdBySessionId = ref<Record<string, number>>({});
  const sessionIdByPtyId = ref<Record<number, string>>({});

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
  function handleHookEvent(
    ptyId: number,
    event: HookEvent,
    payload: Record<string, unknown>,
  ): ClaudeFxEvent | undefined {
    // kill/exit 済みの PTY への遅延イベントを無視（効果も出さない）
    if (!isPtyAlive(ptyId)) return undefined;

    const current = claudeStatusByPtyId.value[ptyId];

    switch (event) {
      case "session-start": {
        cancelAskTimer(ptyId);
        const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
        if (sessionId !== "") {
          // 同 ptyId に旧 sessionId が紐付いていた場合は先に解除する。
          // /clear や /resume で session が切り替わった時、旧 mapping が残ると
          // 別 task のステータスを引いてしまう。
          const previousSessionId = sessionIdByPtyId.value[ptyId];
          if (previousSessionId !== undefined && previousSessionId !== sessionId) {
            delete ptyIdBySessionId.value[previousSessionId];
          }
          sessionIdByPtyId.value[ptyId] = sessionId;
          ptyIdBySessionId.value[sessionId] = ptyId;
          onSessionAttached?.(ptyId, sessionId);
        }
        claudeStatusByPtyId.value[ptyId] = { state: "idle", lastActivityAt: Date.now() };
        return { ptyId, event };
      }
      case "session-end": {
        cancelAskTimer(ptyId);
        const endingSessionId = typeof payload.session_id === "string" ? payload.session_id : "";
        const currentSessionId = sessionIdByPtyId.value[ptyId];
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
          delete ptyIdBySessionId.value[endingSessionId];
          // 旧 session の stale な session-end。効果は出さない。
          return undefined;
        }
        if (currentSessionId !== undefined) {
          delete ptyIdBySessionId.value[currentSessionId];
          delete sessionIdByPtyId.value[ptyId];
        }
        delete claudeStatusByPtyId.value[ptyId];
        // session-end に反応する効果は無いが、解釈結果として発行する
        return { ptyId, event };
      }
      case "running": {
        cancelAskTimer(ptyId);
        claudeStatusByPtyId.value[ptyId] = { state: "working", lastActivityAt: Date.now() };
        return { ptyId, event };
      }
      case "needs-input": {
        const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
        // tool_input は boundary まで JSON 文字列で運ばれるため 1 度だけ構造化する
        const toolInput = parseToolInput(payload.tool_input);
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
        // 効果（アラート音・読み上げ）は従来どおり debounce せず即時発火させる
        return { ptyId, event, toolName, toolInput };
      }
      case "tool-failure": {
        cancelAskTimer(ptyId);
        if (payload.is_interrupt === true) {
          // ユーザーが Ctrl+C でツール実行を中断 → プロンプト待ちに戻る。
          // session-start 後にしか発火しないため current は存在する。
          // current が undefined なら session-start 未到達の仕様外イベントなので無視。
          if (current === undefined) return undefined;
          // lastActivityAt は維持（中断はユーザー操作で、Claude の活動ではない）
          claudeStatusByPtyId.value[ptyId] = {
            state: "idle",
            lastActivityAt: current.lastActivityAt,
          };
          return undefined;
        }
        // interrupt でないツール失敗は tool-done と同じ扱い（working 継続）
        if (current?.state === "done") return undefined;
        claudeStatusByPtyId.value[ptyId] = { state: "working", lastActivityAt: Date.now() };
        return undefined;
      }
      case "tool-done": {
        cancelAskTimer(ptyId);
        // done 後の遅延 tool-done を無視（イベント順序逆転対策）
        if (current?.state === "done") return undefined;
        claudeStatusByPtyId.value[ptyId] = { state: "working", lastActivityAt: Date.now() };
        return { ptyId, event };
      }
      case "done": {
        cancelAskTimer(ptyId);
        const message =
          typeof payload.last_assistant_message === "string"
            ? payload.last_assistant_message
            : undefined;
        // Stop は常に done へ倒す。pending_work（background_tasks / session_crons が残る =
        // 裏で作業継続中）は done バリアントの flag として保持し、表示層 (displayClaudeState) で
        // working として描画して緑バッジを抑止する。working を直接維持すると、Claude が
        // 再起動しないケース（background 完了通知の欠落）で状態が固着し、done 経由でしか効かない
        // clearDoneStates での消化経路を失う。done を必ず経由させることで固着を防ぐ。
        const pendingWork = payload.pending_work === true;
        claudeStatusByPtyId.value[ptyId] = {
          state: "done",
          lastActivityAt: Date.now(),
          message,
          pendingWork,
        };
        // 効果（音・演出・読み上げ）の抑止はここ 1 箇所で行う。pending done は真の完了では
        // ないため fx を発行しない → 購読側は pending を一切意識しない。
        if (pendingWork) return undefined;
        return { ptyId, event, message };
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
        return { ptyId, event, message };
      }
    }
    // 全 HookEvent を case で処理済み。新しい event を追加して case を書き忘れると、ここで
    // `event` が never に絞られず compile error になる（hook event 種別を増やす方向の取りこぼし防止）。
    event satisfies never;
    return undefined;
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
    // 表示用 state を返す（done + pendingWork は working として描画）
    return displayClaudeState(claudeStatusByPtyId.value[ptyId]);
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
    const previousSessionId = sessionIdByPtyId.value[ptyId];
    if (previousSessionId !== undefined) {
      delete ptyIdBySessionId.value[previousSessionId];
      delete sessionIdByPtyId.value[ptyId];
    }
    delete claudeStatusByPtyId.value[ptyId];
  }

  /** task.id (= sessionId) から ClaudeStatus を引く。session 確立前 / pty 終了後は undefined */
  function getStatusBySessionId(sessionId: string): ClaudeStatus | undefined {
    const ptyId = ptyIdBySessionId.value[sessionId];
    if (ptyId === undefined) return undefined;
    return claudeStatusByPtyId.value[ptyId];
  }

  /** task.id (= sessionId) から live PTY の ptyId を引く。未起動 / 終了済みは undefined */
  function getPtyIdBySessionId(sessionId: string): number | undefined {
    return ptyIdBySessionId.value[sessionId];
  }

  /** ptyId から sessionId (= task.id) を引く。OSC title sync で leaf → task 解決に使う */
  function getSessionIdByPtyId(ptyId: number): string | undefined {
    return sessionIdByPtyId.value[ptyId];
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
