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
  rpcTaskAdd,
} from "../../../sidebar";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp, useWorktreeStore } from "../../../worktree";
import { fetchViewer, ghErrorMessage } from "../pr-picker";
import { rpcGitIssueList } from "./rpc";
import { useIssuePicker } from "./useIssuePicker";

/**
 * 同じ issue から派生した worktree を一意に識別する branch 名。
 * issue ↔ worktree の永続マッピングを Task に持たず branch 名に埋め込むことで、
 * 「同じ issue を 2 回選んで worktree が増殖する」退行を防ぎ、Task 永続化が
 * 壊れても worktree 逆引きが成立する。PR picker が `pr.headRef` を真にして
 * いるのと対称。
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
            fetchViewer(dir),
          ]),
        );
        if (!fetchResult.ok) {
          notify.error("Failed to load issues", fetchResult.error);
          return;
        }
        const [issuesRes, worktreesRes, branchesRes, viewerLogin] = fetchResult.value;
        if (!issuesRes.ok) {
          notify.error(
            ghErrorMessage(issuesRes.errorKind, "Failed to load issues"),
            issuesRes.errorDetail || undefined,
          );
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
        // viewer 取得失敗時は undefined。空文字に倒して picker dialog の "@me" filter UI
        // を degraded mode (filter 非表示) にする。
        show(issuesRes.issues, viewerLogin ?? "", (issue) => {
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
            // worktree レスポンスが空のときは早期 return。続行して autostart すると
            // サイドバーに表れない worktree でターミナルだけ動く不整合状態に落ちる
            // (PR-picker と挙動を揃える)。
            if (result.value.worktree === undefined) {
              notify.error("Worktree created but sidebar could not be updated");
              return;
            }
            repoStore.appendWorktree(rootDir, result.value.worktree);
            // issue タイトルを body に持つ task を作成し worktree に紐付ける。
            // Claude session 未起動状態 (sessionId 空) で永続化され、サイドバー行を
            // クリックすると素の claude が起動して SessionStart hook で attach される。
            const taskResult = await tryCatch(
              rpcTaskAdd({
                dir: rootDir,
                body: issue.title,
                worktreeDir: result.value.dir,
                prNumber: 0,
                issueNumber: issue.number,
              }),
            );
            // taskAdd 失敗時は autostart を抑止する。続けると attachSession が
            // 「sessionId 空の最新 task = 無し」経路に入って body 空の新規 task を
            // 作り、issue タイトルを失った状態で永続化される。worktree は残るので
            // ユーザーは手動で復旧でき、再選択で wtByBranch が hit してこの経路を
            // 通らず既存 worktree への切り替えに倒れる。
            if (!taskResult.ok) {
              notify.error("Failed to create task for issue", taskResult.error);
              return;
            }
            if (taskResult.value.task !== undefined) {
              const created = taskResult.value.task;
              const repo = repoStore.repos[rootDir];
              const wt = repo?.worktrees.find((w) => w.path === result.value.dir);
              if (wt !== undefined && !wt.tasks.some((t) => t.id === created.id)) {
                wt.tasks = [...wt.tasks, created];
              }
            }
            // 直後の setOpen で visit が走り初期 leaf が作られる前に autostart ヒントを残す。
            // これで visit が初期 leaf に素の `claude` 起動を仕込み、SessionStart hook で
            // 上で作成した task に attach される。後追いクリック起動の二重 leaf を防ぐ。
            terminalStore.requestNewClaudeSession(result.value.dir);
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
