/**
 * Issue 選択コマンド。
 * コマンドパレットから "Workspace: Open Issue" を実行すると issue picker が開き、
 * issue を選択して worktree を作成する。
 */

import { ghRefForIssue } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { rpcCreateWorktree, rpcGitDefaultBranch, rpcTaskAdd } from "../../../sidebar";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp, useWorktreeStore } from "../../../worktree";
import { fetchViewer, ghErrorMessage } from "../pr-picker";
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
          Promise.all([rpcGitIssueList({ dir }), fetchViewer(dir)]),
        );
        if (!fetchResult.ok) {
          notify.error("Failed to load issues", fetchResult.error);
          return;
        }
        const [issuesRes, viewerLogin] = fetchResult.value;
        if (!issuesRes.ok) {
          notify.error(
            ghErrorMessage(issuesRes.errorKind, "Failed to load issues"),
            issuesRes.errorDetail || undefined,
          );
          return;
        }
        if (issuesRes.issues.length === 0) return;

        // この callback は IssuePickerDialog 側で close() 後に呼ばれるため、
        // 連打による再エントリは dialog の DOM 除去で塞がれている。`isCreating` 相当のガードは不要。
        // viewer 取得失敗時は undefined。空文字に倒して picker dialog の "@me" filter UI
        // を degraded mode (filter 非表示) にする。
        show(issuesRes.issues, viewerLogin ?? "", (issue) => {
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
            // 通常の新規 worktree と同じ timestamp ベースで命名する。issue 番号を branch 名に
            // 埋め込まないため、同じ issue から複数の worktree を独立して作れる。
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
            // taskAdd 後の真値反映は requestRefresh に委ねる (楽観更新で renderer 側を
            // 直書きしない)。失敗時は autostart を抑止し、worktree だけ残る (task 不在の
            // ため `git worktree remove` で手動回収するか、再度 issue を選び直して別の
            // worktree を作る)。
            const taskResult = await tryCatch(
              rpcTaskAdd({
                dir: rootDir,
                userTitle: "",
                ghTitle: issue.title,
                worktreeDir: result.value.dir,
                ghRef: ghRefForIssue(issue.number),
              }),
            );
            if (!taskResult.ok) {
              notify.error("Failed to create task for issue", taskResult.error);
              return;
            }
            repoStore.requestRefresh(rootDir);
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
