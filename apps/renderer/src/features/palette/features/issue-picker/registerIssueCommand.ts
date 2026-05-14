/**
 * Issue 選択コマンド。
 * コマンドパレットから "Workspace: Open Issue" を実行すると issue picker が開き、
 * issue を選択して worktree を作成する。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { rpcCreateWorktree, rpcGitDefaultBranch } from "../../../sidebar";
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
  const repoStore = useRepoStore();

  const dispose = registry.register("workspace.openIssue", {
    label: "Workspace: Open Issue",
    precondition: "isGitRepo",
    handler: () => {
      void (async () => {
        const dir = worktreeStore.dir;
        if (dir === undefined) return;
        const fetchResult = await tryCatch(
          Promise.all([rpcGitIssueList({ dir }), rpcGitViewer({ dir })]),
        );
        if (!fetchResult.ok) {
          notify.error("Failed to load issues", fetchResult.error);
          return;
        }
        const [issuesRes, viewerRes] = fetchResult.value;
        if (!issuesRes.ok) {
          notify.error("Failed to load issues from GitHub");
          return;
        }
        if (issuesRes.issues.length === 0) return;

        // 既存 worktree との紐付けは issue #504 で Task = session 化により喪失。
        // 別 issue で再設計するまでは常に新規 worktree を作る挙動。

        // この callback は IssuePickerDialog 側で close() 後に呼ばれるため、
        // 連打による再エントリは dialog の DOM 除去で塞がれている。`isCreating` 相当のガードは不要。
        show(issuesRes.issues, viewerRes.ok ? viewerRes.login : "", (_issue) => {
          void (async () => {
            // 新規 worktree は default branch を起点に作る。Swift 側で `origin/HEAD` を
            // 優先し、未設定（remote 無し / push 前 repo）の場合は main repo root 自身の
            // current branch に fallback して解決した ref を受け取り、`startPoint` に渡す。
            const rootDir = repoStore.findRepoOwning(dir)?.rootDir;
            if (rootDir === undefined) {
              notify.error("Failed to resolve repo root for worktree creation");
              return;
            }
            const branchResult = await tryCatch(rpcGitDefaultBranch({ dir: rootDir }));
            if (!branchResult.ok || branchResult.value.branch === "") {
              notify.error(
                "Failed to resolve default branch",
                branchResult.ok ? undefined : branchResult.error,
              );
              return;
            }
            const timestamp = generateTimestamp();
            const result = await tryCatch(
              rpcCreateWorktree({
                dir: rootDir,
                worktreeDir: timestamp,
                branch: timestamp,
                startPoint: branchResult.value.branch,
              }),
            );
            if (!result.ok) {
              notify.error("Failed to create worktree", result.error);
              return;
            }
            // issue / wt の紐付けは Task で持っていたが、issue #504 で Task = session 化
            // したため経路を喪失。issue↔worktree の永続マッピングは別 issue で再設計する。
            if (result.value.worktree === undefined) {
              notify.error("Worktree created but sidebar could not be updated");
            } else {
              repoStore.appendWorktree(rootDir, result.value.worktree);
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
