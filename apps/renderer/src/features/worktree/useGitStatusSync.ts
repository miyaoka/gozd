/**
 * git status を最新に保つ app-scope な watcher。更新の契機は 3 つ:
 * - dir 切替時（gitStatusChange は watch 開始時には push されないため、切替自体を契機に含める）
 * - 同 dir に紐づく PTY の Claude state 遷移時
 * - native 側 FSWatchRegistry からの gitStatusChange push（全 worktree が対象。payload の dir で
 *   該当 worktree に直接反映する）
 */
import type { GitStatusChangePayload } from "@gozd/rpc";
import { onMounted, onUnmounted, watch } from "vue";
import { logEvent } from "../../shared/debug";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { useGitStatusStore } from "./useGitStatusStore";
import { useWorktreeStore } from "./useWorktreeStore";

interface GitStatusSyncOptions {
  /** dir に紐づく Claude 群の state 集合を安定キー化した文字列を返す reactive getter。
   * worktree feature は「エージェントの状態が動いたら status を取り直す」ことだけを知り、
   * 状態の持ち主 (terminal store) は composition root (App.vue) が注入する。 */
  claudeStateKeyOf: (dir: string) => string;
}

export function useGitStatusSync(options: GitStatusSyncOptions) {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
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
      return options.claudeStateKeyOf(dir);
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
        statuses: payload.entries,
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
