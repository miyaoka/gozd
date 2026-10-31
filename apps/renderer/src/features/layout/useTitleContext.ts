import type { WorktreeEntry } from "@gozd/rpc";
import { computed, type ComputedRef } from "vue";
import { useRepoStore, worktreeLabel } from "../../shared/repo";

/**
 * タイトル文字列（"repo · worktree の名前"）を導出する純関数。
 * dir が repo の worktrees に見つからない場合は repoName のみ（repo も無ければ空文字）に縮退する。
 */
export function formatTitleContext(
  repo: { repoName: string; worktrees: WorktreeEntry[] } | undefined,
  dir: string | undefined,
): string {
  if (repo === undefined) return "";
  const worktree =
    dir === undefined ? undefined : repo.worktrees.find((entry) => entry.path === dir);
  if (worktree === undefined) return repo.repoName;
  return `${repo.repoName} · ${worktreeLabel(worktree)}`;
}

/**
 * ウィンドウタイトル文字列の導出 SSOT。
 * useTitleContextSync が native title の push に使う。
 */
export function useTitleContext(): ComputedRef<string> {
  const repoStore = useRepoStore();
  return computed(() => formatTitleContext(repoStore.selectedRepo, repoStore.selectedDir));
}
