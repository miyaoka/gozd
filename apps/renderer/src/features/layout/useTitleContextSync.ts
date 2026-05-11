import { WindowSetTitleContextRequest } from "@gozd/proto";
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

  watch(
    () => {
      const repo = repoStore.selectedRepo;
      const dir = repoStore.selectedDir;
      if (repo === undefined || dir === undefined) {
        return { repoName: "", worktreeName: "" };
      }
      const wt = repo.worktrees.find((entry) => entry.path === dir);
      const worktreeName = wt?.branch ?? "";
      return { repoName: repo.repoName, worktreeName };
    },
    async (ctx) => {
      // active な repo がまだ無い起動直後は push しない。native 側は空文字を受け取ると
      // ContentView 側で windowTitle ("gozd" / "gozd (dev)") にフォールバックするが、
      // 空 push のラウンドトリップ自体を省くことで toolbar の一瞬の空表示を避ける。
      if (ctx.repoName === "" && ctx.worktreeName === "") return;
      const req = WindowSetTitleContextRequest.create({
        repoName: ctx.repoName,
        worktreeName: ctx.worktreeName,
      });
      const result = await tryCatch(rpcWindowSetTitleContext(req));
      if (!result.ok) {
        notify.error("Failed to sync window title context", result.error);
      }
    },
    { immediate: true, deep: false },
  );
}
