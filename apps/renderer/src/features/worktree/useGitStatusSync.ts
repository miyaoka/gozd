/**
 * 選択中 dir の git status を最新に保つ app-scope な watcher。
 *
 * docs/workspace.md の「git status は選択中 dir のみ」方針に従い、以下のトリガで store を更新する:
 * - dir 切替時（gitStatusChange は watch 開始時には push されないため、切替自体をトリガに含める）
 * - 同 dir に紐づく PTY の Claude state 遷移時（fs 変更がない静的な repo でも反映させるため）
 * - native 側 FSWatchRegistry からの gitStatusChange push（外部エディタ等での編集を反映）
 */
import { onMounted, onUnmounted, watch } from "vue";
import { logEvent } from "../../shared/debug";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { useTerminalStore } from "../terminal";
import type { GitStatusChangePayload } from "./rpc";
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

  let cleanup: (() => void) | undefined;
  onMounted(() => {
    // gitStatusChange は payload に dir を持つので、active 制限なしで該当 worktree の
    // gitStatuses を直接 repoStore に反映する。サイドバー / Filer / GitGraph は
    // すべて repoStore（または派生 computed）を読むので 1 回の書き込みで全箇所が更新される。
    cleanup = onMessage<GitStatusChangePayload>("gitStatusChange", (payload) => {
      // payload.dir は source worktree。basename を repo 列に出す (findRepoOwning の O(repos) 探索を
      // push ごとに走らせないため、ここでは所有 repo 解決ではなく worktree 名だけ載せる)。
      const wtName =
        payload.dir
          .split("/")
          .filter((s) => s !== "")
          .at(-1) ?? payload.dir;
      logEvent("git-status", "change", wtName);
      repoStore.setWorktreeGitStatuses(payload.dir, {
        statuses: payload.statuses,
        renameOldPaths: payload.renameOldPaths,
        upstream: payload.upstream,
        latestMtime: payload.latestMtime,
      });
    });
  });
  onUnmounted(() => {
    cleanup?.();
  });
}
