/**
 * PR 選択コマンド。
 * コマンドパレットから "Workspace: Open Pull Request" を実行すると PR picker が開き、
 * PR を選択して worktree を作成する。既にブランチの worktree が存在する場合はそちらに切り替える。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { rpcCreateWorktree, rpcGitWorktreeList, rpcTaskAdd } from "../../../sidebar";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp, useWorktreeStore } from "../../../worktree";
import { ghErrorMessage } from "./ghError";
import { rpcGitPrList } from "./rpc";
import { usePrPicker } from "./usePrPicker";
import { fetchViewer } from "./useViewer";

export function registerPrCommand(): () => void {
  const registry = useCommandRegistry();
  const { show } = usePrPicker();
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const repoStore = useRepoStore();

  const dispose = registry.register("workspace.openPr", {
    label: "Workspace: Open Pull Request",
    precondition: "isGitRepo",
    handler: () => {
      void (async () => {
        const dir = worktreeStore.dir;
        if (dir === undefined) return;
        const fetchResult = await tryCatch(
          Promise.all([rpcGitPrList({ dir }), rpcGitWorktreeList({ dir }), fetchViewer(dir)]),
        );
        if (!fetchResult.ok) {
          notify.error("Failed to load pull requests", fetchResult.error);
          return;
        }
        const [prsRes, worktreesRes, viewerLogin] = fetchResult.value;
        if (!prsRes.ok) {
          notify.error(
            ghErrorMessage(prsRes.errorKind, "Failed to load pull requests"),
            prsRes.errorDetail || undefined,
          );
          return;
        }
        if (prsRes.prs.length === 0) return;

        const wtByBranch = new Map(
          worktreesRes.worktrees.filter((wt) => wt.branch !== "").map((wt) => [wt.branch, wt.path]),
        );

        // この callback は PrPickerDialog 側で close() 後に呼ばれるため、
        // 連打による再エントリは dialog の DOM 除去で塞がれている。`isCreating` 相当のガードは不要。
        // viewer 取得失敗時は undefined。空文字に倒して picker dialog の "@me" filter UI
        // を degraded mode (filter 非表示) にする。表示ロジックは PrPickerDialog 側の
        // `viewer !== ""` 判定で完結する。
        show(prsRes.prs, viewerLogin ?? "", (pr) => {
          const existingDir = wtByBranch.get(pr.headRef);
          if (existingDir !== undefined) {
            // 既存 worktree に切り替え（ステートレス化により switchDir RPC は廃止）
            terminalStore.viewMode = "wt";
            worktreeStore.setOpen(existingDir);
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
            const rootDir = repoStore.findRepoOwning(dir)?.rootDir;
            if (rootDir === undefined || result.value.worktree === undefined) {
              notify.error("Worktree created but sidebar could not be updated");
            } else {
              repoStore.appendWorktree(rootDir, result.value.worktree);
            }
            // PR タイトルを body に持つ task を作成し worktree に紐付ける。
            // Claude session 未起動状態 (sessionId 空) で永続化され、初期 leaf で
            // 素の claude を autostart して SessionStart hook で attach される。
            if (rootDir !== undefined) {
              const taskResult = await tryCatch(
                rpcTaskAdd({
                  dir: rootDir,
                  body: pr.title,
                  worktreeDir: result.value.dir,
                  prNumber: pr.number,
                  issueNumber: 0,
                }),
              );
              if (!taskResult.ok) {
                notify.error("Failed to create task for pull request", taskResult.error);
              } else if (taskResult.value.task !== undefined) {
                const created = taskResult.value.task;
                const repo = repoStore.repos[rootDir];
                const wt = repo?.worktrees.find((w) => w.path === result.value.dir);
                if (wt !== undefined && !wt.tasks.some((t) => t.id === created.id)) {
                  wt.tasks = [...wt.tasks, created];
                }
              }
            }
            // 直後の setOpen で visit が走り初期 leaf が作られる前に autostart ヒントを残す。
            // visit が初期 leaf に素の `claude` 起動を仕込み、SessionStart hook で
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
