/**
 * Claude session log の生 JSONL を `sessionId` 1 つに対してライブ取得する composable。
 *
 * 責務は raw `SessionTab[]` の供給のみ:
 *   - 初回 / `sessionId` 変更時の `rpcClaudeSessionLog` 取得
 *   - native が返す specific projectDir (~/.claude/projects/<encoded>/) の `rpcFsWatch`
 *     ライフサイクル
 *   - `fsChange` push を debounce してサイレント refresh
 *
 * parse (`parseSessionLog`) や branch 選択、subagent 並び替えは呼び出し側 (dialog /
 * terminal preview) の責務に閉じる。SSOT は entries の SessionTab 配列で、UI 形状の
 * 違いはここに乗らない。
 *
 * stale 結果の上書きを防ぐ `loadToken` パターンは SessionLogDialog から踏襲。
 *
 * ## worktreePath を渡す理由
 *
 * Claude Code の JSONL は SessionStart 時点では作られず、最初の UserPromptSubmit で初めて
 * 書かれる。watch 対象 dir は cwd の `/` `.` を `-` に置換した形式で一意に決まるので、
 * worktreePath を渡せば JSONL の有無に関わらず最初から specific projectDir を fsWatch
 * できる。native は不在なら idempotent mkdir で作るので、FSWatchRegistry が watch 対象の
 * cwd で git CLI を spawn する経路 (gitDirs 解決) で launchFailed を踏まない。
 *
 * projects 親 (~/.claude/projects/) への fallback は持たない: 親には他セッションの jsonl
 * も同居するため、fsChange の cross-session ノイズで refresh が常時走り続けるため。
 */
import { tryCatch } from "@gozd/shared";
import { onUnmounted, ref, watch, type Ref } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { rpcFsUnwatch, rpcFsWatch, type FsChangePayload } from "../filer";
import { rpcClaudeSessionLog } from "./rpc";
import { subagentTabLabel } from "./sessionLog";

// main + subagents の単位。生 JSONL を保持し、parse は呼び出し側で行う。
export interface SessionTab {
  kind: string; // "main" | "subagent"
  id: string; // main は session_id、subagent は agent_id
  label: string; // タブ表示名
  // subagent を spawn した main の Agent tool_use id (meta.json の toolUseId)。main は空。
  parentToolUseId: string;
  // subagent の名前 (meta.json の name)。SendMessage の to が name のとき紐付けに使う。main は空。
  name: string;
  // workflow agent が属する workflow run の id。非 workflow subagent / main は空。
  workflowRunId: string;
  // workflow の表示名 (グループ見出し)。非 workflow subagent / main は空。
  workflowName: string;
  // 生 JSONL。parse は呼び出し側の computed で行う (branchSelection 依存等)。
  content: string;
}

interface UseSessionLogLiveOptions {
  /** fsChange debounce (ms)。jsonl は 1 応答中に多数追記が走るため coalesce する。 */
  debounceMs?: number;
}

interface UseSessionLogLiveReturn {
  sessions: Ref<SessionTab[]>;
  loading: Ref<boolean>;
  errorMessage: Ref<string | undefined>;
  notFound: Ref<boolean>;
}

export function useSessionLogLive(
  sessionId: Ref<string | null | undefined>,
  worktreePath: Ref<string | null | undefined>,
  options: UseSessionLogLiveOptions = {},
): UseSessionLogLiveReturn {
  const debounceMs = options.debounceMs ?? 250;
  const notify = useNotificationStore();

  const sessions = ref<SessionTab[]>([]);
  const loading = ref(false);
  const errorMessage = ref<string | undefined>(undefined);
  const notFound = ref(false);

  // load の世代カウンタ。await を跨いだ stale な完了結果が新しいセッション表示を上書き
  // するのを防ぐ。新規 load 開始 / refresh / unwatch のたびに increment し、await 後に
  // 自分の token が最新でなければ state を触らず捨てる。
  let loadToken = 0;
  let currentWatchDir: string | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  function toSessionTab(entry: {
    kind: string;
    id: string;
    label: string;
    agentType: string;
    parentToolUseId: string;
    name: string;
    workflowRunId: string;
    workflowName: string;
    phaseTitle: string;
    content: string;
  }): SessionTab {
    return {
      kind: entry.kind,
      id: entry.id,
      label: entry.kind === "main" ? "Main" : subagentTabLabel(entry),
      parentToolUseId: entry.parentToolUseId,
      name: entry.name,
      workflowRunId: entry.workflowRunId,
      workflowName: entry.workflowName,
      content: entry.content,
    };
  }

  async function setWatchDir(next: string | undefined) {
    if (next === currentWatchDir) return;
    const prev = currentWatchDir;
    currentWatchDir = next;
    if (prev !== undefined) {
      const r = await tryCatch(rpcFsUnwatch({ dir: prev }));
      if (!r.ok) notify.error("Failed to stop watching session log", r.error);
    }
    if (next !== undefined) {
      const r = await tryCatch(rpcFsWatch({ dir: next }));
      if (!r.ok) notify.error("Failed to watch session log", r.error);
    }
  }

  function normalizeStr(s: string | null | undefined): string {
    return s === undefined || s === null ? "" : s;
  }

  function cancelRefresh() {
    if (refreshTimer === undefined) return;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }

  function scheduleRefresh() {
    cancelRefresh();
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, debounceMs);
  }

  // native は watch_dir に specific projectDir を返す契約。空文字は worktreePath 不正 or
  // mkdir 失敗のシグナルなので、silent に「watch を張らない」に倒さず観察ログに残す。
  function applyWatchDirOrWarn(watchDir: string) {
    if (watchDir === "") {
      notify.error(
        "Failed to resolve session log watch dir",
        new Error("native returned empty watch_dir (contract violation)"),
      );
      void setWatchDir(undefined);
      return;
    }
    void setWatchDir(watchDir);
  }

  async function load(sid: string) {
    const token = ++loadToken;
    loading.value = true;
    errorMessage.value = undefined;
    notFound.value = false;
    sessions.value = [];

    const result = await tryCatch(
      rpcClaudeSessionLog({ sessionId: sid, worktreePath: normalizeStr(worktreePath.value) }),
    );
    if (token !== loadToken) return;
    loading.value = false;
    if (!result.ok) {
      errorMessage.value = result.error.message;
      notify.error("Failed to read session log", result.error);
      return;
    }
    applyWatchDirOrWarn(result.value.watchDir);
    if (!result.value.found || result.value.entries.length === 0) {
      notFound.value = true;
      return;
    }
    sessions.value = result.value.entries.map(toSessionTab);
  }

  // 既存表示を保ったまま jsonl を読み直す。loading は立てず sessions の差し替えだけ。
  // 一過性の読み取り失敗 / 消失で画面を消さない。
  async function refresh() {
    const sid = sessionId.value;
    if (sid === undefined || sid === null || sid === "") return;
    const token = ++loadToken;
    const result = await tryCatch(
      rpcClaudeSessionLog({ sessionId: sid, worktreePath: normalizeStr(worktreePath.value) }),
    );
    if (token !== loadToken) return;
    if (!result.ok) {
      notify.error("Failed to refresh session log", result.error);
      return;
    }
    applyWatchDirOrWarn(result.value.watchDir);
    if (!result.value.found || result.value.entries.length === 0) return;
    sessions.value = result.value.entries.map(toSessionTab);
    notFound.value = false;
  }

  const stopFsChange = onMessage<FsChangePayload>("fsChange", ({ dir, relDir }) => {
    const sid = sessionId.value;
    if (sid === undefined || sid === null || sid === "") return;
    if (dir !== currentWatchDir) return;
    // specific projectDir 直下には他セッションの <other_sid>.jsonl も同居しうる
    // (同 cwd で複数 session を resume / 連続起動した場合)。当該セッションの main
    // (relDir === "") か subagents (relDir が "<sessionId>/...") の変更だけ拾う。
    if (relDir !== "" && !relDir.startsWith(sid)) return;
    scheduleRefresh();
  });

  // sessionId / worktreePath どちらが先に確定しても、両方揃った時点で load を起動できる
  // ように 2 値の組で watch する。preview 経路では paneRegistry 設定 → PTY spawn →
  // session-start hook の順で worktreePath が先、sessionId が後に確定するが、composable
  // 自身はこの順序保証を持たないため。
  watch(
    [sessionId, worktreePath],
    ([nextSid]) => {
      // 進行中の load を無効化し、stale 結果が次セッションの state を書き戻すのを防ぐ。
      loadToken++;
      cancelRefresh();
      if (nextSid === undefined || nextSid === null || nextSid === "") {
        sessions.value = [];
        loading.value = false;
        errorMessage.value = undefined;
        notFound.value = false;
        void setWatchDir(undefined);
        return;
      }
      void load(nextSid);
    },
    { immediate: true },
  );

  onUnmounted(() => {
    stopFsChange();
    cancelRefresh();
    loadToken++;
    void setWatchDir(undefined);
  });

  return { sessions, loading, errorMessage, notFound };
}
