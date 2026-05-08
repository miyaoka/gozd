/**
 * PR 選択コマンド。
 * コマンドパレットから "Workspace: Open Pull Request" を実行すると PR picker が開き、
 * PR を選択して worktree を作成する。既にブランチの worktree が存在する場合はそちらに切り替える。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { rpcCreateWorktree, rpcGitWorktreeList, rpcTaskAdd } from "../../../sidebar";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp, useWorktreeStore } from "../../../worktree";
import { rpcGitPrList, rpcGitViewer } from "./rpc";
import { usePrPicker } from "./usePrPicker";

export function registerPrCommand(): () => void {
  const registry = useCommandRegistry();
  const { show } = usePrPicker();
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();

  const dispose = registry.register("workspace.openPr", {
    label: "Workspace: Open Pull Request",
    precondition: "isGitRepo",
    handler: () => {
      void (async () => {
        const dir = worktreeStore.dir;
        if (dir === undefined) return;
        const [prsRes, worktreesRes, viewerRes] = await Promise.all([
          rpcGitPrList({ dir }),
          rpcGitWorktreeList({ dir }),
          rpcGitViewer({ dir }),
        ]);
        if (!prsRes.ok || prsRes.prs.length === 0) return;

        const wtByBranch = new Map(
          worktreesRes.worktrees.filter((wt) => wt.branch !== "").map((wt) => [wt.branch, wt.path]),
        );

        show(prsRes.prs, viewerRes.ok ? viewerRes.login : "", (pr) => {
          const existingDir = wtByBranch.get(pr.headRef);
          if (existingDir !== undefined) {
            // 既存 worktree に切り替え（ステートレス化により switchDir RPC は廃止）
            terminalStore.viewMode = "wt";
            worktreeStore.setOpen(existingDir, undefined, undefined);
            return;
          }
          // 新規 worktree 作成
          void (async () => {
            const result = await tryCatch(
              rpcCreateWorktree({
                dir,
                worktreeDir: generateTimestamp(),
                branch: pr.headRef,
                startPoint: `origin/${pr.headRef}`,
              }),
            );
            if (!result.ok) {
              notify.error("Failed to create worktree", result.error);
              return;
            }
            const taskResult = await tryCatch(
              rpcTaskAdd({
                dir,
                body: pr.title,
                worktreeDir: result.value.dir,
                prNumber: pr.number,
                issueNumber: 0,
              }),
            );
            if (!taskResult.ok) {
              notify.error("Failed to create task for worktree", taskResult.error);
            }
            terminalStore.viewMode = "wt";
            worktreeStore.setOpen(result.value.dir, undefined, undefined);
          })();
        });
      })();

      return true;
    },
  });

  return dispose;
}
