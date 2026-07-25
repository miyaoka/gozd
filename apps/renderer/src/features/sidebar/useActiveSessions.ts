import type { ComputedRef } from "vue";
import { computed } from "vue";
import { useRepoStore } from "../../shared/repo";
import { useTerminalStore } from "../terminal";
import { collectActiveSessionGroups } from "./activeSessions";
import type { ActiveSessionGroup } from "./activeSessions";

/**
 * 下段（active session ペイン）に出すセッション群。
 *
 * 中身（`ActiveSessionsPane`）と、ペインを縦分割の枠として出すかどうかの判定
 * （`SidebarPane` のリサイズハンドル + 高さ）の 2 箇所が同じ集合を見る必要があるため、
 * 導出をここに置いて両者から呼ぶ。
 */
export function useActiveSessions(): ComputedRef<ActiveSessionGroup[]> {
  const repoStore = useRepoStore();
  const terminalStore = useTerminalStore();

  return computed(() =>
    collectActiveSessionGroups(
      repoStore.poolDirs,
      repoStore.repos,
      terminalStore.claudeActiveDirs,
      (sessionId) => terminalStore.getClaudeStatusBySessionId(sessionId),
    ),
  );
}
