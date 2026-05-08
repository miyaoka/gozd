/**
 * Issue 選択コマンド。
 * コマンドパレットから "Workspace: Open Issue" を実行すると issue picker が開き、
 * issue を選択して worktree を作成する。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { rpcCreateWorktree, rpcGitWorktreeList, rpcTaskAdd } from "../../../sidebar";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp, useWorktreeStore } from "../../../worktree";
import { rpcGitViewer } from "../pr-picker";
import { rpcGitIssueList } from "./rpc";
import { useIssuePicker } from "./useIssuePicker";

export function registerIssueCommand(): () => void {
  const registry = useCommandRegistry();
  const { show } = useIssuePicker();
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();

  const dispose = registry.register("workspace.openIssue", {
    label: "Workspace: Open Issue",
    precondition: "isGitRepo",
    handler: () => {
      void (async () => {
        const dir = worktreeStore.dir;
        if (dir === undefined) return;
        const [issuesRes, worktreesRes, viewerRes] = await Promise.all([
          rpcGitIssueList({ dir }),
          rpcGitWorktreeList({ dir }),
          rpcGitViewer({ dir }),
        ]);
        if (!issuesRes.ok || issuesRes.issues.length === 0) return;

        const wtByIssue = new Map(
          worktreesRes.worktrees
            .filter((wt) => wt.task !== undefined && wt.task.issueNumber > 0)
            .map((wt) => [wt.task?.issueNumber, wt.path]),
        );

        show(issuesRes.issues, viewerRes.ok ? viewerRes.login : "", (issue) => {
          const existingDir = wtByIssue.get(issue.number);
          if (existingDir !== undefined) {
            terminalStore.viewMode = "wt";
            worktreeStore.setOpen(existingDir);
            return;
          }
          void (async () => {
            const timestamp = generateTimestamp();
            const result = await tryCatch(
              rpcCreateWorktree({
                dir,
                worktreeDir: timestamp,
                branch: timestamp,
                startPoint: "HEAD",
              }),
            );
            if (!result.ok) {
              notify.error("Failed to create worktree", result.error);
              return;
            }
            const taskResult = await tryCatch(
              rpcTaskAdd({
                dir,
                body: issue.title,
                worktreeDir: result.value.dir,
                prNumber: 0,
                issueNumber: issue.number,
              }),
            );
            if (!taskResult.ok) {
              notify.error("Failed to create task for worktree", taskResult.error);
            }
            terminalStore.viewMode = "wt";
            worktreeStore.setOpen(result.value.dir);
          })();
        });
      })();

      return true;
    },
  });

  return dispose;
}
