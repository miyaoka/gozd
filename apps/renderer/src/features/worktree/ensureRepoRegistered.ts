/**
 * repo を window のワークスペースに載せる。
 *
 * main 発の「この dir を開け」系 push（`gozd <path>` / `gozd worktree new`）が共通で通る
 * 前段。未登録なら worktree 一覧を取得して登録し、登録済みならアクティブ repo list に
 * 載っていることだけ保証する（プールには居るがリストに無い repo を開いたとき、リストに
 * 現れないと「開いたのに何も起きない」ため）。
 */
import type { WorktreeEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcGitWorktreeList } from "./rpc";

export async function ensureRepoRegistered(params: {
  /** 未登録だったときに repo として登録する dir */
  rootDir: string;
  /** 登録済みかを判定する dir。開こうとしている worktree の dir を渡す（その worktree を
   * 抱えた repo が既に居れば登録は不要）。rootDir と同じでよい場合もある */
  openDir: string;
  /** 未登録だったときにサイドバーへ出す表示名 */
  repoName: string;
  isGitRepo: boolean;
}): Promise<void> {
  const { rootDir, openDir, repoName, isGitRepo } = params;
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  const owning = repoStore.findRepoOwning(openDir);
  if (owning !== undefined) {
    repoStore.ensureInActiveRepoList(owning.rootDir);
    return;
  }
  let worktrees: WorktreeEntry[] = [];
  if (isGitRepo) {
    const result = await tryCatch(rpcGitWorktreeList({ dir: rootDir }));
    if (result.ok) {
      worktrees = result.value.worktrees;
    } else {
      // 一覧が引けなくても repo 自体は登録する。登録しないと「開いた」要求が無反応で終わる
      notify.error("Failed to fetch repo data", result.error);
    }
  }
  repoStore.addRepo({ rootDir, repoName, isGitRepo, worktrees });
}
