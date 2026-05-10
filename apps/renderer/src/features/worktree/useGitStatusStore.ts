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

  /** 並行 loadGitStatus で古いレスポンスが新しい結果を上書きするのを防ぐ世代カウンタ */
  let loadGen = 0;

  /**
   * active dir の git status を rpcGitStatus で取得し直して repoStore を更新する。
   * dir 切替時 / Claude state 遷移時 / Filer の初期読み込みで呼ばれる。
   */
  async function loadGitStatus() {
    const gen = ++loadGen;
    if (!repoStore.selectedIsGitRepo) return;
    const dir = repoStore.selectedDir;
    if (dir === undefined) return;
    const result = await tryCatch(rpcGitStatus({ dir }));
    if (gen !== loadGen) return;
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
