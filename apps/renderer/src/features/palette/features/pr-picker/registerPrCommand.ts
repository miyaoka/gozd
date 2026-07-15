/**
 * PR 選択コマンド。
 * コマンドパレットから "Workspace: New Worktree from Pull Request" を実行すると PR picker が開き、
 * PR を選択して worktree を作成する。既にブランチの worktree が存在する場合はそちらに切り替える。
 */

import { ghRefForPr } from "@gozd/rpc";
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
import { inFlightKey, useInFlightGhRefs } from "../../inFlightGhRefs";
import { buildTaskIndexByGhRef, ghRefKey } from "../../taskIndexByGhRef";
import { ghErrorMessage } from "./ghError";
import { rpcGitPrList } from "./rpc";
import { usePrPicker } from "./usePrPicker";
import type { PrPickerItem } from "./usePrPicker";
import { fetchViewer } from "./useViewer";

export function registerPrCommand(): () => void {
  const registry = useCommandRegistry();
  const { open, setResult, hide } = usePrPicker();
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const repoStore = useRepoStore();
  const inFlightGhRefs = useInFlightGhRefs();

  const dispose = registry.register("workspace.openPr", {
    label: "Workspace: New Worktree from Pull Request",
    precondition: "isGitRepo",
    handler: () => {
      void (async () => {
        const dir = worktreeStore.dir;
        if (dir === undefined) return;
        // fetch 前に picker を loading で開き、gh GraphQL の待ち時間を可視化する。
        // 取得が空でも下の setResult で empty state を表示する。
        // gen は stale 応答 (open 後に別 open で開き直された場合) を捨てるための世代。
        const gen = open();
        const fetchResult = await tryCatch(
          Promise.all([rpcGitPrList({ dir }), rpcGitWorktreeList({ dir }), fetchViewer(dir)]),
        );
        if (!fetchResult.ok) {
          // hide が作用した (現在世代) ときだけ toast する。superseded な起動の失敗は抑止する。
          if (hide(gen)) notify.error("Failed to load pull requests", fetchResult.error);
          return;
        }
        const [prsRes, worktreesRes, viewerLogin] = fetchResult.value;
        if (!prsRes.ok) {
          if (hide(gen)) {
            notify.error(
              ghErrorMessage(prsRes.errorKind, "Failed to load pull requests"),
              prsRes.errorDetail || undefined,
            );
          }
          return;
        }

        const wtByBranch = new Map(
          worktreesRes.worktrees.filter((wt) => wt.branch !== "").map((wt) => [wt.branch, wt.path]),
        );

        // repo 内の既存 task を ghRef で JOIN する。dialog は existingTask の有無で行の
        // 色を変え、選択時は新規作成ではなく既存 task の worktree 表示に倒す。
        const owningRepo = repoStore.findRepoOwning(dir);
        const taskByGhRef = buildTaskIndexByGhRef(owningRepo?.worktrees ?? []);
        const items = prsRes.prs.map(
          (pr): PrPickerItem => ({
            pr,
            existingTask: taskByGhRef.get(ghRefKey(ghRefForPr(pr.number))),
            refKey: inFlightKey(owningRepo?.rootDir ?? dir, ghRefForPr(pr.number)),
          }),
        );

        // accept の実体。失敗はすべて notify 済みで resolve する (throw しない) 契約。
        // 完了時に item.existingTask へ task を書き戻す (item は dialog が picker.items
        // (reactive) から渡す proxy) ことで、開いたままの一覧の行が作成済み表示に変わり、
        // 同 PR の再選択が既存切り替えルートに倒れる。
        const acceptPr = async (item: PrPickerItem): Promise<void> => {
          const { pr } = item;
          // 既存 task の worktree を最優先で採用する（task が指す worktree が sidebar で
          // ユーザーが見ている実体）。task 不在で branch の worktree だけ残っている場合は
          // 従来の branch hit として同じ切り替え + upsert 蘇生ルートに乗せる。
          const existingDir = item.existingTask?.worktreeDir ?? wtByBranch.get(pr.headRef);
          if (existingDir !== undefined) {
            // 既存 worktree に切り替え（ステートレス化により switchDir RPC は廃止）。
            // 直前に terminal close で closed_by_user 化されている可能性があるため、
            // 同 ghRef で taskAdd (server 側 upsert) を呼んで closed_by_user を解除する。
            // 完了後の真値反映は `useRepoStore.requestRefresh` 経由で `useSidebarData` の
            // fetchRepo に委譲する (楽観更新で renderer 側を直書きしない)。
            const revived = await reviveTaskForGhRef({
              existingDir,
              ghTitle: pr.title,
              ghRef: ghRefForPr(pr.number),
              errorLabel: "Failed to revive task for pull request",
            });
            if (revived !== undefined) item.existingTask = revived;
            terminalStore.viewMode = "wt";
            worktreeStore.setOpen(existingDir);
            return;
          }
          // 新規 worktree 作成
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
          item.existingTask = taskResult.value.task;
          repoStore.requestRefresh(rootDir);
          // 直後の setOpen で visit が走り初期 leaf が作られる前に autostart ヒントを残す。
          // visit が初期 leaf に素の `claude` 起動を仕込み、SessionStart hook で
          // 上で作成した task に attach される。後追いクリック起動の二重 leaf を防ぐ。
          // PR URL を prefill で渡し、claude の入力欄に事前挿入する (送信はされない)。
          terminalStore.requestNewClaudeSession(result.value.dir, pr.url);
          terminalStore.setPreferredSetup(result.value.dir, result.value.setupScript);
          terminalStore.viewMode = "wt";
          worktreeStore.setOpen(result.value.dir);
        };

        // viewer 取得失敗時は undefined。空文字に倒して picker dialog の "@me" filter UI
        // を degraded mode (filter 非表示) にする。表示ロジックは PrPickerDialog 側の
        // `viewer !== ""` 判定で完結する。
        // callback は async で、返す promise が処理完了 (成功 / 失敗を問わず) を表す。
        // 実行中の排他は dialog ではなくここ (コマンド層) が inFlightGhRefs で持つ。
        // dialog の状態は close / 開き直しで破棄されるため、通常選択 (close 後の
        // fire-and-forget 実行) 中に picker を開き直して同じ PR を選ぶ経路を dialog 側
        // では塞げない。dialog は同じ集合を参照して選択をブロックするので通常ここには
        // 来ないが、ブロック反映前の競合窓で到達しうるため観察可能化して弾く。
        setResult(gen, items, viewerLogin ?? "", async (item) => {
          if (inFlightGhRefs.has(item.refKey)) {
            notify.info(`PR #${item.pr.number} is already being processed`);
            return;
          }
          inFlightGhRefs.add(item.refKey);
          const accepted = await tryCatch(acceptPr(item));
          inFlightGhRefs.remove(item.refKey);
          if (!accepted.ok) {
            // acceptPr は失敗を notify 済みで resolve する契約なので、ここに来るのは
            // 契約違反の throw = 真の未通知失敗。packaged では console が不可視のため、
            // ユーザーに surface するトーストで観察可能化する
            notify.error("Failed to process pull request selection", accepted.error);
          }
        });
      })();

      return true;
    },
  });

  return dispose;
}
