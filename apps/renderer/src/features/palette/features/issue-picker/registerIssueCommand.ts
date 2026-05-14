/**
 * Issue 選択コマンド。
 * コマンドパレットから "Workspace: Open Issue" を実行すると issue picker が開き、
 * issue を選択して worktree を作成する。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import {
  rpcCreateWorktree,
  rpcGitBranchList,
  rpcGitDefaultBranch,
  rpcGitWorktreeList,
} from "../../../sidebar";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp, useWorktreeStore } from "../../../worktree";
import { rpcGitViewer } from "../pr-picker";
import { rpcGitIssueList } from "./rpc";
import { useIssuePicker } from "./useIssuePicker";

/**
 * 同じ issue から派生した worktree を一意に識別する branch 名。
 * Task = session 同一視ルール以降、issue ↔ worktree の永続マッピングを
 * branch 名に埋め込んで検出することで「同じ issue を 2 回選んで worktree が
 * 増殖する」退行を防ぐ。PR picker が `pr.headRef` を真にしているのと対称。
 */
function issueBranchName(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

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
          Promise.all([
            rpcGitIssueList({ dir }),
            rpcGitWorktreeList({ dir }),
            rpcGitBranchList({ dir }),
            rpcGitViewer({ dir }),
          ]),
        );
        if (!fetchResult.ok) {
          notify.error("Failed to load issues", fetchResult.error);
          return;
        }
        const [issuesRes, worktreesRes, branchesRes, viewerRes] = fetchResult.value;
        if (!issuesRes.ok) {
          notify.error("Failed to load issues from GitHub");
          return;
        }
        if (issuesRes.issues.length === 0) return;

        // branch 名から既存 worktree を逆引きする。issue picker の決定的 branch
        // (`issue-<number>`) と PR picker の `pr.headRef` の両方をこのマップで吸う。
        const wtByBranch = new Map(
          worktreesRes.worktrees.filter((wt) => wt.branch !== "").map((wt) => [wt.branch, wt.path]),
        );
        // worktree 不在の孤立 branch も含めた local branch 一覧。`issue-<N>` の
        // 決定的命名衝突を事前検出するために使う。
        const allBranches = new Set(branchesRes.branches);

        // この callback は IssuePickerDialog 側で close() 後に呼ばれるため、
        // 連打による再エントリは dialog の DOM 除去で塞がれている。`isCreating` 相当のガードは不要。
        show(issuesRes.issues, viewerRes.ok ? viewerRes.login : "", (issue) => {
          const branchName = issueBranchName(issue.number);
          const existingDir = wtByBranch.get(branchName);
          if (existingDir !== undefined) {
            terminalStore.viewMode = "wt";
            worktreeStore.setOpen(existingDir);
            return;
          }
          // `issue-<N>` が worktree を持たない孤立 branch として既に存在する場合、
          // `git worktree add -b issue-<N>` は "branch already exists" で失敗する。
          // 事前検出してユーザーに復旧操作 (`git branch -D <name>` 等) を促す。
          if (allBranches.has(branchName)) {
            notify.error(
              `Branch '${branchName}' already exists without a worktree. ` +
                `Remove or rename it before opening this issue.`,
            );
            return;
          }
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
            const result = await tryCatch(
              rpcCreateWorktree({
                dir: rootDir,
                worktreeDir: generateTimestamp(),
                branch: branchName,
                startPoint: branchResult.value.branch,
              }),
            );
            if (!result.ok) {
              notify.error("Failed to create worktree", result.error);
              return;
            }
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
