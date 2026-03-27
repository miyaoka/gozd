/**
 * PR 選択コマンド。
 * コマンドパレットから "Workspace: Open Pull Request" を実行すると PR picker が開き、
 * PR を選択して worktree を作成する。既にブランチの worktree が存在する場合はそちらに切り替える。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useRpc } from "../../../../shared/rpc";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp, useWorktreeStore } from "../../../worktree";
import { usePrPicker } from "./usePrPicker";

export function registerPrCommand(): () => void {
  const registry = useCommandRegistry();
  const { request } = useRpc();
  const { show } = usePrPicker();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();

  const dispose = registry.register("workspace.openPr", {
    label: "Workspace: Open Pull Request",
    precondition: "isGitRepo",
    handler: () => {
      void (async () => {
        const [prs, worktrees, viewer] = await Promise.all([
          request.gitPrList(undefined),
          request.gitWorktreeList(),
          request.gitViewer(undefined),
        ]);
        if (!prs || prs.length === 0) return;

        // ブランチ名 → worktree パスのマップ（既存 worktree の検索用）
        const wtByBranch = new Map(
          worktrees.filter((wt) => wt.branch).map((wt) => [wt.branch, wt.path]),
        );

        show(prs, viewer ?? "", (pr) => {
          const existingDir = wtByBranch.get(pr.headRefName);
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
            const result = await tryCatch(
              request.createWorktree({
                worktreeDir: generateTimestamp(),
                branch: pr.headRefName,
              }),
            );
            if (!result.ok) {
              console.error("Failed to create worktree:", result.error);
              return;
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
