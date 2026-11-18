import type { HookPayload } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { type ClaudeTaskList, EMPTY_TASK_LIST, mergeTaskList } from "./claudeTaskList";
import { rpcClaudeTaskList } from "./rpc";

/** タスクを書き換えうる hook。TaskCreate / TaskUpdate はツール呼び出しなので、完了の
 * tool-done で読み直せば追従する。done はターン末尾の取りこぼしを拾い直す */
const RELOAD_EVENTS: ReadonlySet<string> = new Set(["tool-done", "done", "session-start"]);

/** 1 ターンで続けて届く tool-done を、セッションごとに 1 回の読み直しにまとめる */
const RELOAD_DEBOUNCE_MS = 150;

// HMR 再実行で hook の購読を二重に登録しないための disposer。module スコープに置き、
// 再実行をまたいで前回の購読を解除する
let disposeHook: (() => void) | undefined;

/**
 * 端末で動いている全 Claude セッションのタスク一覧。生きているセッションが現れたら読み、
 * そのセッションの hook が届いたら読み直し、セッションが終わったら捨てる。
 */
export const useClaudeTasksStore = defineStore("claudeTasks", () => {
  const terminalStore = useTerminalStore();
  const worktreeStore = useWorktreeStore();
  const notify = useNotificationStore();

  const listsBySessionId = ref<Record<string, ClaudeTaskList>>({});
  /** 古い応答で新しい一覧を上書きしないための、セッションごとの最新の世代 */
  const loadTokens = new Map<string, number>();
  /** 世代の通し番号。セッションを捨てて同じ ID が再び現れても、捨てる前の世代と一致させない */
  let loadSeq = 0;
  const reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async function load(sessionId: string) {
    const token = ++loadSeq;
    loadTokens.set(sessionId, token);
    const result = await tryCatch(rpcClaudeTaskList({ sessionId }));
    if (loadTokens.get(sessionId) !== token) return;
    // 読んでいる間にセッションが終わっていたら残さない
    if (!liveSessionIds.value.has(sessionId)) return;
    if (!result.ok) {
      notify.error("Failed to read Claude tasks", result.error);
      return;
    }
    listsBySessionId.value[sessionId] = mergeTaskList(
      listsBySessionId.value[sessionId],
      result.value,
    );
  }

  function forget(sessionId: string) {
    clearTimeout(reloadTimers.get(sessionId));
    reloadTimers.delete(sessionId);
    loadTokens.delete(sessionId);
    delete listsBySessionId.value[sessionId];
  }

  const liveSessionIds = computed(
    () => new Set(terminalStore.liveSessions.map((session) => session.sessionId)),
  );

  watch(
    liveSessionIds,
    (current, previous) => {
      for (const sessionId of current) {
        if (previous?.has(sessionId) !== true) void load(sessionId);
      }
      for (const sessionId of previous ?? []) {
        if (!current.has(sessionId)) forget(sessionId);
      }
    },
    { immediate: true },
  );

  disposeHook?.();
  disposeHook = onMessage<HookPayload>("hook", (payload) => {
    if (!RELOAD_EVENTS.has(payload.event)) return;
    const sessionId = terminalStore.getSessionIdByPtyId(payload.ptyId);
    if (sessionId === undefined) return;
    clearTimeout(reloadTimers.get(sessionId));
    reloadTimers.set(
      sessionId,
      setTimeout(() => {
        reloadTimers.delete(sessionId);
        void load(sessionId);
      }, RELOAD_DEBOUNCE_MS),
    );
  });

  /** 選択中の worktree でフォーカスが当たっている端末の Claude セッション */
  const focusedSessionId = computed(() => {
    const dir = worktreeStore.dir;
    return dir === undefined ? undefined : terminalStore.focusedSessionIdOf(dir);
  });

  const focusedList = computed(() => {
    const sessionId = focusedSessionId.value;
    if (sessionId === undefined) return EMPTY_TASK_LIST;
    return listsBySessionId.value[sessionId] ?? EMPTY_TASK_LIST;
  });

  return { listsBySessionId, focusedSessionId, focusedList };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useClaudeTasksStore, import.meta.hot));
}
