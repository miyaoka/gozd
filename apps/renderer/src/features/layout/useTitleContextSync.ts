import { tryCatch } from "@gozd/shared";
import { watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcWindowSetTitleContext } from "./rpc";

/**
 * Active な repo / worktree の表示用文字列を native の toolbar に push する。
 * native 側 TitleContext.shared.text を更新し、ContentView の ToolbarItem(.principal) が再 render する。
 */
export function useTitleContextSync(): void {
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  // watch を primitive 文字列の getter 配列で組む。getter が object を返すと
  // identity が毎 tick 変わって watch が常時 fire する。primitive string なら
  // `===` 比較で「値が変わったときだけ」発火する。
  watch(
    [
      () => repoStore.selectedRepo?.repoName ?? "",
      () => {
        const repo = repoStore.selectedRepo;
        const dir = repoStore.selectedDir;
        if (repo === undefined || dir === undefined) return "";
        return repo.worktrees.find((entry) => entry.path === dir)?.branch ?? "";
      },
    ],
    async ([repoName, worktreeName]) => {
      // active な repo がまだ無い起動直後は push しない。native 側は空文字を受け取ると
      // ContentView 側で windowTitle ("gozd" / "gozd (dev)") にフォールバックするが、
      // 空 push のラウンドトリップ自体を省くことで toolbar の一瞬の空表示を避ける。
      if (repoName === "" && worktreeName === "") return;
      const result = await tryCatch(rpcWindowSetTitleContext({ repoName, worktreeName }));
      if (!result.ok) {
        notify.error("Failed to sync window title context", result.error);
      }
    },
    { immediate: true },
  );
}
