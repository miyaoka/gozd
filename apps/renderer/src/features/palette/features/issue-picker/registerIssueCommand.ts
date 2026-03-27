/**
 * Issue 選択コマンド。
 * コマンドパレットから "Workspace: Open Issue" を実行すると issue picker が開き、
 * issue を選択して worktree を作成する。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useRpc } from "../../../../shared/rpc";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp, useWorktreeStore } from "../../../worktree";
import { useIssuePicker } from "./useIssuePicker";

export function registerIssueCommand(): () => void {
  const registry = useCommandRegistry();
  const { request } = useRpc();
  const { show } = useIssuePicker();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();

  const dispose = registry.register("workspace.openIssue", {
    label: "Workspace: Open Issue",
    precondition: "isGitRepo",
    handler: () => {
      void (async () => {
        const [issues, worktrees, viewer] = await Promise.all([
          request.gitIssueList(undefined),
          request.gitWorktreeList(),
          request.gitViewer(undefined),
        ]);
        if (!issues || issues.length === 0) return;

        // issueNumber → worktree パスのマップ（既存 worktree の検索用）
        const wtByIssue = new Map(
          worktrees
            .filter((wt) => wt.task?.issueNumber !== undefined)
            .map((wt) => [wt.task?.issueNumber, wt.path]),
        );

        show(issues, viewer ?? "", (issue) => {
          const existingDir = wtByIssue.get(issue.number);
          if (existingDir) {
            // 既存 worktree に切り替え
            void (async () => {
              const result = await tryCatch(request.switchDir({ dir: existingDir }));
              if (!result.ok) {
                console.error("Failed to switch worktree:", result.error);
                return;
              }
              terminalStore.viewMode = "wt";
              worktreeStore.setOpen(result.value.dir, undefined, result.value.fileServerBaseUrl);
            })();
            return;
          }
          // 新規 worktree 作成
          void (async () => {
            const timestamp = generateTimestamp();
            const result = await tryCatch(
              request.createWorktree({
                worktreeDir: timestamp,
                branch: timestamp,
              }),
            );
            if (!result.ok) {
              console.error("Failed to create worktree:", result.error);
              return;
            }
            // issue タイトルを task として作成し、worktree に紐づける
            const taskResult = await tryCatch(
              request.taskAdd({
                body: issue.title,
                worktreeDir: result.value.dir,
                issueNumber: issue.number,
              }),
            );
            if (!taskResult.ok) {
              console.error("Failed to create task for worktree:", taskResult.error);
            }
            terminalStore.viewMode = "wt";
            worktreeStore.setOpen(result.value.dir, undefined, result.value.fileServerBaseUrl);
          })();
        });
      })();

      return true;
    },
  });

  return dispose;
}
