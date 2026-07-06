import type { WorktreeEntry } from "@gozd/rpc";
import { computed, type ComputedRef } from "vue";
import { useRepoStore } from "../../shared/repo";

/**
 * タイトル文字列（"repo · worktree"）を導出する純関数。
 * active な repo が無い場合と、dir が repo の worktrees に見つからない場合は
 * worktree 部を落として repoName のみ（repo も無ければ空文字）に縮退する。
 */
export function formatTitleContext(
  repo: { repoName: string; worktrees: WorktreeEntry[] } | undefined,
  dir: string | undefined,
): string {
  if (repo === undefined) return "";
  const worktreeName =
    dir === undefined ? "" : (repo.worktrees.find((entry) => entry.path === dir)?.branch ?? "");
  return [repo.repoName, worktreeName].filter((part) => part !== "").join(" · ");
}

/**
 * ウィンドウタイトル文字列の導出 SSOT。
 * TitleBar.vue の表示と useTitleContextSync の native title push が共有する。
 */
export function useTitleContext(): ComputedRef<string> {
  const repoStore = useRepoStore();
  return computed(() => formatTitleContext(repoStore.selectedRepo, repoStore.selectedDir));
}
