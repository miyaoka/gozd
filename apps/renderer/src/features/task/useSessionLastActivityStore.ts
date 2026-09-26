import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { useTerminalStore } from "../terminal";
import { rpcClaudeSessionLastActivity } from "./rpc";

/**
 * live な Claude を持たない task の最終活動時刻（セッションログ末尾の timestamp）を
 * sessionId 単位で保持する。
 *
 * ログが伸びるのは live のあいだだけで、そのあいだの基準時刻は ClaudeStatus.lastActivityAt が
 * 担う。したがって sessionId が inactive 集合に入った時点で 1 回読めば、次に live になるまで
 * 値は変わらない。
 */
export const useSessionLastActivityStore = defineStore("sessionLastActivity", () => {
  const repoStore = useRepoStore();
  const terminalStore = useTerminalStore();
  const notify = useNotificationStore();

  const lastActivityBySessionId = ref<Record<string, number>>({});

  /** repo プール全体の task のうち、session を持つが live status の無いもの */
  const inactiveSessionIds = computed<string[]>(() => {
    const ids = new Set<string>();
    for (const rootDir of repoStore.poolDirs) {
      const repo = repoStore.repos[rootDir];
      if (repo === undefined) continue;
      for (const wt of repo.worktrees) {
        for (const task of wt.tasks) {
          if (task.sessionId === "") continue;
          if (terminalStore.getClaudeStatusBySessionId(task.sessionId) !== undefined) continue;
          ids.add(task.sessionId);
        }
      }
    }
    return [...ids];
  });

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
      const prevSet = new Set(prev);
      const entered = next.filter((id) => !prevSet.has(id));
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
