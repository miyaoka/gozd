import { WindowSetTitleContextRequest } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { rpcWindowSetTitleContext } from "./rpc";

/**
 * Active な repo / worktree の表示用文字列を native の toolbar に push する。
 * native 側 TitleContext.shared.text を更新し、ContentView の ToolbarItem(.principal) が再 render する。
 */
export function useTitleContextSync(): void {
  const repoStore = useRepoStore();

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
      const req = WindowSetTitleContextRequest.create({
        repoName: ctx.repoName,
        worktreeName: ctx.worktreeName,
      });
      await tryCatch(rpcWindowSetTitleContext(req));
    },
    { immediate: true, deep: false },
  );
}
