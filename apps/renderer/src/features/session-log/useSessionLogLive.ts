/**
 * Claude session log の生 JSONL を `sessionId` 1 つに対してライブ取得する composable。
 *
 * 責務は raw `SessionTab[]` の供給のみ:
 *   - 初回 / `sessionId` 変更時の `rpcClaudeSessionLog` 取得
 *   - 親 dir (`~/.claude/projects/<encoded>/`) の `rpcFsWatch` ライフサイクル
 *   - `fsChange` push を debounce してサイレント refresh
 *
 * parse (`parseSessionLog`) や branch 選択、subagent 並び替えは呼び出し側 (dialog /
 * terminal preview) の責務に閉じる。SSOT は entries の SessionTab 配列で、UI 形状の
 * 違いはここに乗らない。
 *
 * stale 結果の上書きを防ぐ `loadToken` パターンは SessionLogDialog から踏襲。
 */
import { tryCatch } from "@gozd/shared";
import { onUnmounted, ref, watch, type Ref } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { rpcFsUnwatch, rpcFsWatch, type FsChangePayload } from "../filer";
import { rpcClaudeSessionLog } from "./rpc";
import { sessionLogDirOf, subagentTabLabel } from "./sessionLog";

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

  async function load(sid: string) {
    const token = ++loadToken;
    loading.value = true;
    errorMessage.value = undefined;
    notFound.value = false;
    sessions.value = [];

    const result = await tryCatch(rpcClaudeSessionLog({ sessionId: sid }));
    if (token !== loadToken) return;
    loading.value = false;
    if (!result.ok) {
      errorMessage.value = result.error.message;
      notify.error("Failed to read session log", result.error);
      return;
    }
    if (!result.value.found || result.value.entries.length === 0) {
      notFound.value = true;
      return;
    }

    sessions.value = result.value.entries.map(toSessionTab);
    void setWatchDir(sessionLogDirOf(result.value.entries));
  }

  // 既存表示を保ったまま jsonl を読み直す。loading は立てず sessions の差し替えだけ。
  // 一過性の読み取り失敗 / 消失で画面を消さない。
  async function refresh() {
    const sid = sessionId.value;
    if (sid === undefined || sid === null || sid === "") return;
    const token = ++loadToken;
    const result = await tryCatch(rpcClaudeSessionLog({ sessionId: sid }));
    if (token !== loadToken) return;
    if (!result.ok) {
      notify.error("Failed to refresh session log", result.error);
      return;
    }
    if (!result.value.found || result.value.entries.length === 0) return;
    sessions.value = result.value.entries.map(toSessionTab);
  }

  const stopFsChange = onMessage<FsChangePayload>("fsChange", ({ dir, relDir }) => {
    const sid = sessionId.value;
    if (sid === undefined || sid === null || sid === "") return;
    if (dir !== currentWatchDir) return;
    // 親 dir には他セッションの jsonl も同居する。当該セッションの main (relDir === "")
    // か subagents (relDir が "<sessionId>/...") の変更だけ拾い、無関係な再読込を減らす。
    if (relDir !== "" && !relDir.startsWith(sid)) return;
    scheduleRefresh();
  });

  watch(
    sessionId,
    (next) => {
      // 進行中の load を無効化し、stale 結果が次セッションの state を書き戻すのを防ぐ。
      loadToken++;
      cancelRefresh();
      if (next === undefined || next === null || next === "") {
        sessions.value = [];
        loading.value = false;
        errorMessage.value = undefined;
        notFound.value = false;
        void setWatchDir(undefined);
        return;
      }
      void load(next);
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
