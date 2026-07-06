import { computed, type ComputedRef } from "vue";
import { useRepoStore } from "../../shared/repo";

/**
 * ウィンドウタイトル文字列（"repo · worktree"）の導出 SSOT。
 * TitleBar.vue の表示と useTitleContextSync の native title push が共有する。
 * active な repo が無い起動直後は空文字を返す。
 */
export function useTitleContext(): ComputedRef<string> {
  const repoStore = useRepoStore();
  return computed(() => {
    const repo = repoStore.selectedRepo;
    const dir = repoStore.selectedDir;
    if (repo === undefined) return "";
    const worktreeName =
      dir === undefined ? "" : (repo.worktrees.find((entry) => entry.path === dir)?.branch ?? "");
    return [repo.repoName, worktreeName].filter((part) => part !== "").join(" · ");
  });
}
