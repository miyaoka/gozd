import type { GhRef } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcTaskAdd } from "./rpc";

/**
 * PR picker の `pr.headRef` hit ルート専用ヘルパー。
 *
 * 同じ PR を再選択した時に、terminal close で `closed_by_user=true` 化された既存 task を
 * server 側 `TaskStore.add` の upsert (同 worktreeDir + 同 ghRef キー) で蘇生する。
 * `gh_title` を最新の PR タイトルで上書きし、`closed_by_user=false` に倒す。ユーザーが
 * dialog で編集した `user_title` は触らない (3 レイヤ分離契約)。
 * 成功後は `repoStore.requestRefresh(rootDir)` で SSOT 取り直しを `useSidebarData` に
 * 依頼する (楽観更新で `repos[...]` を直書きしない)。
 *
 * issue picker は branch を timestamp ベースにしており既存 worktree hit ルートを持たない
 * (同 issue から複数 worktree が独立して生える設計) ため、本ヘルパーは PR picker からのみ
 * 呼ばれる。
 */
export async function reviveTaskForGhRef(params: {
  existingDir: string;
  ghTitle: string;
  ghRef: GhRef;
  errorLabel: string;
}): Promise<void> {
  const { existingDir, ghTitle, ghRef, errorLabel } = params;
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  const rootDir = repoStore.findRepoOwning(existingDir)?.rootDir;
  if (rootDir === undefined) {
    // wtByBranch.get で見つけた path なので worktreesRes 経由で存在は保証されている。
    // ここに来るのは repoStore.repos と worktreeList の整合が壊れた異常ケースなので
    // silent skip せず観察可能化する。詳細は cause 経由で渡して、トースト本文は
    // `errorLabel` のまま短く保つ (CLAUDE.md renderer の通知規約)。
    notify.error(errorLabel, new Error(`repo root not resolved for ${existingDir}`));
    return;
  }

  const result = await tryCatch(
    rpcTaskAdd({
      dir: rootDir,
      userTitle: "",
      ghTitle,
      worktreeDir: existingDir,
      ghRef,
    }),
  );
  if (!result.ok) {
    notify.error(errorLabel, result.error);
    return;
  }
  repoStore.requestRefresh(rootDir);
}
