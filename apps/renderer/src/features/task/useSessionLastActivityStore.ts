import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { useTerminalStore } from "../terminal";
import { collectInactiveSessionIds, enteredSessionIds } from "./inactiveSessionIds";
import { rpcClaudeSessionLastActivity } from "./rpc";

/**
 * live な Claude を持たない task の最終活動時刻（セッションログ末尾の timestamp）を
 * sessionId 単位で保持する。
 *
 * このインスタンスで live な間の基準時刻は ClaudeStatus.lastActivityAt が担うため、
 * sessionId が inactive 集合に入った時点で 1 回だけ読む。このインスタンスの外（別 channel の
 * gozd / 素のターミナル）で同じ session が動いてログが伸びても、次に集合へ入り直すまで
 * 読み直さない。
 */
export const useSessionLastActivityStore = defineStore("sessionLastActivity", () => {
  const repoStore = useRepoStore();
  const terminalStore = useTerminalStore();
  const notify = useNotificationStore();

  const lastActivityBySessionId = ref<Record<string, number>>({});

  const inactiveSessionIds = computed(() =>
    collectInactiveSessionIds(
      repoStore.poolDirs,
      repoStore.repos,
      (sessionId) => terminalStore.getClaudeStatusBySessionId(sessionId) !== undefined,
    ),
  );

  async function load(sessionIds: string[]) {
    const result = await tryCatch(rpcClaudeSessionLastActivity({ sessionIds }));
    if (!result.ok) {
      notify.error("Failed to read Claude session last activity", result.error);
      return;
    }
    Object.assign(lastActivityBySessionId.value, result.value.lastActivityBySessionId);
  }

  // 新たに inactive になった sessionId（task の出現 / live session の終了）だけを読む
  watch(
    inactiveSessionIds,
    (next, prev) => {
      const entered = enteredSessionIds(next, prev);
      if (entered.length > 0) void load(entered);
    },
    { immediate: true },
  );

  function get(sessionId: string): number | undefined {
    return lastActivityBySessionId.value[sessionId];
  }

  return { get };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessionLastActivityStore, import.meta.hot));
}
