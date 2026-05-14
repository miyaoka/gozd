/**
 * PR 選択コマンド。
 * コマンドパレットから "Workspace: Open Pull Request" を実行すると PR picker が開き、
 * PR を選択して worktree を作成する。既にブランチの worktree が存在する場合はそちらに切り替える。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { rpcCreateWorktree, rpcGitWorktreeList } from "../../../sidebar";
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
        show(prsRes.prs, viewerLogin, (pr) => {
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
            // PR ↔ worktree 紐付けは旧 Task で持っていたが、task = session 同一視
            // への移行で経路を喪失している。永続マッピングは WorktreeEntry 側に
            // 再設計予定 (現状は branch 名一致を `wtByBranch` で代替)。
            const rootDir = repoStore.findRepoOwning(dir)?.rootDir;
            if (rootDir === undefined || result.value.worktree === undefined) {
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
