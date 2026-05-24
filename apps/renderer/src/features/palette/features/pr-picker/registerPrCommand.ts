/**
 * PR 選択コマンド。
 * コマンドパレットから "Workspace: Open Pull Request" を実行すると PR picker が開き、
 * PR を選択して worktree を作成する。既にブランチの worktree が存在する場合はそちらに切り替える。
 */

import { ghRefForPr } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import {
  reviveTaskForGhRef,
  rpcCreateWorktree,
  rpcGitWorktreeList,
  rpcTaskAdd,
} from "../../../sidebar";
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
            // 既存 worktree に切り替え（ステートレス化により switchDir RPC は廃止）。
            // 直前に terminal close で closed_by_user 化されている可能性があるため、
            // 同 ghRef で taskAdd (server 側 upsert) を呼んで closed_by_user を解除する。
            // 完了後の真値反映は `useRepoStore.requestRefresh` 経由で `useSidebarData` の
            // fetchRepo に委譲する (楽観更新で renderer 側を直書きしない)。
            void (async () => {
              await reviveTaskForGhRef({
                existingDir,
                ghTitle: pr.title,
                ghRef: ghRefForPr(pr.number),
                errorLabel: "Failed to revive task for pull request",
              });
              terminalStore.viewMode = "wt";
              worktreeStore.setOpen(existingDir);
            })();
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
            // rootDir が解決できない / worktree レスポンスが空のときは早期 return。
            // 続行して autostart すると、サイドバーに表れない worktree でターミナル
            // だけ動く不整合状態に落ちる。issue-picker と挙動を揃える。
            const rootDir = repoStore.findRepoOwning(dir)?.rootDir;
            if (rootDir === undefined || result.value.worktree === undefined) {
              notify.error("Worktree created but sidebar could not be updated");
              return;
            }
            repoStore.appendWorktree(rootDir, result.value.worktree);
            // PR タイトルを userTitle に持つ task を作成し worktree に紐付ける。
            // Claude session 未起動状態 (sessionId 空) で永続化され、初期 leaf で
            // 素の claude を autostart して SessionStart hook で attach される。
            // wtByBranch hit ルートと同じく taskAdd 後の真値反映は requestRefresh
            // に委ねる (楽観更新で renderer 側を直書きしない)。失敗時の挙動も
            // 同じく autostart を抑止して、worktree だけ残った状態でユーザーに復旧を
            // 委ねる (再選択で wtByBranch hit に倒れる)。
            const taskResult = await tryCatch(
              rpcTaskAdd({
                dir: rootDir,
                ghTitle: pr.title,
                worktreeDir: result.value.dir,
                ghRef: ghRefForPr(pr.number),
              }),
            );
            if (!taskResult.ok) {
              notify.error("Failed to create task for pull request", taskResult.error);
              return;
            }
            repoStore.requestRefresh(rootDir);
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
