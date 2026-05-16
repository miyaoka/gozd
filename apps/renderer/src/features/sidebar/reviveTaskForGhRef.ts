import type { GhRef } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { rpcTaskAdd } from "./rpc";

/**
 * PR/issue picker の wtByBranch hit ルート専用ヘルパー。
 *
 * 同じ PR/issue を再選択した時に、terminal close で `hidden=true` 化された既存 task を
 * server 側 `TaskStore.add` の upsert (同 worktreeDir + 同 ghRef キー) で蘇生する。
 * 成功後は `repoStore.requestRefresh(rootDir)` で SSOT 取り直しを `useSidebarData` に
 * 依頼する (楽観更新で `repos[...]` を直書きしない)。
 *
 * pr-picker / issue-picker の hit ルートは body / ghRef が違うだけで構造は同じだったため、
 * SSOT 違反を避けて 1 ヶ所に集約する。
 */
export async function reviveTaskForGhRef(params: {
  existingDir: string;
  body: string;
  ghRef: GhRef;
  errorLabel: string;
}): Promise<void> {
  const { existingDir, body, ghRef, errorLabel } = params;
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  const rootDir = repoStore.findRepoOwning(existingDir)?.rootDir;
  if (rootDir === undefined) {
    // wtByBranch.get で見つけた path なので worktreesRes 経由で存在は保証されている。
    // ここに来るのは repoStore.repos と worktreeList の整合が壊れた異常ケースなので
    // silent skip せず観察可能化する。
    notify.error(`${errorLabel}: repo root not resolved for ${existingDir}`);
    return;
  }

  const result = await tryCatch(
    rpcTaskAdd({ dir: rootDir, body, worktreeDir: existingDir, ghRef }),
  );
  if (!result.ok) {
    notify.error(errorLabel, result.error);
    return;
  }
  repoStore.requestRefresh(rootDir);
}
