import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcGitStatus } from "./rpc";

/**
 * active worktree の git status を提供する読み取り専用 store。
 *
 * 真の source は `repoStore.repos[rootDir].worktrees[i].gitStatuses`。
 * この store は active dir に対応する worktree.gitStatuses を派生 computed として
 * 公開し、書き込みは `repoStore.setWorktreeGitStatuses(dir, statuses)` に集約する。
 *
 * 設計理由:
 *
 * - サイドバーは `wt.gitStatuses` を直接読むため、別 store に最新値を持つと
 *   gitStatusChange push 受信時に「サイドバーは更新されないが Filer は更新される」
 *   という SSOT 違反が起きる
 * - ファイル変更 push に対し、Swift 側に worktree list を全件再 RPC させる経路を
 *   挟まずに、push payload を直接 repoStore に書いて全リーダーへ伝搬させる
 */
export const useGitStatusStore = defineStore("gitStatus", () => {
  const repoStore = useRepoStore();

  /** active dir の gitStatuses を repoStore から派生させる */
  const gitStatuses = computed<Record<string, string>>(() => {
    const dir = repoStore.selectedDir;
    if (dir === undefined) return {};
    const repo = repoStore.findRepoOwning(dir);
    const wt = repo?.worktrees.find((w) => w.path === dir);
    return wt?.gitStatuses ?? {};
  });

  /**
   * active dir の git status を rpcGitStatus で取得し直して repoStore を更新する。
   * dir 切替時 / Claude state 遷移時 / Filer の初期読み込みで呼ばれる。
   *
   * 世代管理は repoStore.gitStatusGenByDir に集約。`setWorktreeGitStatuses` を
   * 経由する push 経路と、ここでの RPC レスポンス到着が競合した場合、
   * 開始時の世代と現在の世代を比較して RPC レスポンスが古ければ捨てる。
   */
  async function loadGitStatus() {
    if (!repoStore.selectedIsGitRepo) return;
    const dir = repoStore.selectedDir;
    if (dir === undefined) return;
    const startGen = repoStore.getGitStatusGen(dir);
    const result = await tryCatch(rpcGitStatus({ dir }));
    if (repoStore.getGitStatusGen(dir) !== startGen) return;
    if (result.ok) {
      repoStore.setWorktreeGitStatuses(dir, result.value.entries);
    } else {
      const notify = useNotificationStore();
      notify.error("Failed to get git status", result.error);
    }
  }

  return { gitStatuses, loadGitStatus };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGitStatusStore, import.meta.hot));
}
