/**
 * 選択中 dir の git status を最新に保つ app-scope な watcher。
 *
 * docs/workspace.md の「git status は選択中 dir のみ」方針に従い、以下のトリガで loadGitStatus する:
 * - dir 切替時（fsChange / gitStatusChange は watch 開始時には push されないため、切替自体をトリガに含める）
 * - 同 dir に紐づく PTY の Claude state 遷移時（fs 変更がない静的な repo でも反映させるため）
 */
import { watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { useTerminalStore } from "../terminal";
import { useGitStatusStore } from "./useGitStatusStore";
import { useWorktreeStore } from "./useWorktreeStore";

export function useGitStatusSync() {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const gitStatusStore = useGitStatusStore();

  watch(
    () => worktreeStore.dir,
    () => {
      void gitStatusStore.loadGitStatus();
    },
    { immediate: true },
  );

  watch(
    () => {
      const dir = repoStore.selectedDir;
      if (dir === undefined) return "";
      return terminalStore
        .getClaudeStatusesByDir(dir)
        .map((s) => s.state)
        .sort()
        .join(",");
    },
    (newKey, oldKey) => {
      if (newKey === oldKey) return;
      void gitStatusStore.loadGitStatus();
    },
  );
}
