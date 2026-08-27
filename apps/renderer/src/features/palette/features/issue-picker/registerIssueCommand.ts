/**
 * Issue 選択コマンド。
 * コマンドパレットから "Workspace: New Worktree from Issue" を実行すると issue picker が開き、
 * issue を選択して worktree を作成する。既に task がある issue はそちらの worktree に切り替える。
 */

import { ghRefForIssue } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { ghErrorMessage } from "../../../github-item";
import { reviveTaskForGhRef } from "../../../task";
import { activateDir, openCreatedWorktree } from "../../../terminal";
import { rpcCreateTaskWorktree, useWorktreeStore } from "../../../worktree";
import { inFlightKey, useInFlightGhRefs } from "../../inFlightGhRefs";
import { buildTaskIndexByGhRef, ghRefKey } from "../../taskIndexByGhRef";
import { fetchViewer } from "../pr-picker";
import { rpcGitIssueList } from "./rpc";
import { useIssuePicker } from "./useIssuePicker";
import type { IssuePickerItem } from "./useIssuePicker";

export function registerIssueCommand(): () => void {
  const registry = useCommandRegistry();
  const { open, setResult, hide } = useIssuePicker();
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const repoStore = useRepoStore();
  const inFlightGhRefs = useInFlightGhRefs();

  const dispose = registry.register("workspace.openIssue", {
    label: "Workspace: New Worktree from Issue",
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
          Promise.all([rpcGitIssueList({ dir }), fetchViewer(dir)]),
        );
        if (!fetchResult.ok) {
          // hide が作用した (現在世代) ときだけ toast する。superseded な起動の失敗は抑止する。
          if (hide(gen)) notify.error("Failed to load issues", fetchResult.error);
          return;
        }
        const [issuesRes, viewerLogin] = fetchResult.value;
        if (!issuesRes.ok) {
          if (hide(gen)) {
            notify.error(
              ghErrorMessage(issuesRes.errorKind, "Failed to load issues"),
              issuesRes.errorDetail || undefined,
            );
          }
          return;
        }

        // repo 内の既存 task を ghRef で JOIN する。dialog は existingTask の有無で行の
        // 色を変え、選択時は新規作成ではなく既存 task の worktree 表示に倒す。
        const owningRepo = repoStore.findRepoOwning(dir);
        const taskByGhRef = buildTaskIndexByGhRef(owningRepo?.worktrees ?? []);
        const items = issuesRes.issues.map((issue): IssuePickerItem => ({
          issue,
          existingTask: taskByGhRef.get(ghRefKey(ghRefForIssue(issue.number))),
          refKey: inFlightKey(owningRepo?.rootDir ?? dir, ghRefForIssue(issue.number)),
        }));

        // accept の実体。失敗はすべて notify 済みで resolve する (throw しない) 契約。
        // 完了時に item.existingTask へ task を書き戻す (item は dialog が picker.items
        // (reactive) から渡す proxy) ことで、開いたままの一覧の行が作成済み表示に変わり、
        // 同 issue の再選択が既存切り替えルートに倒れる。
        const acceptIssue = async (item: IssuePickerItem): Promise<void> => {
          const { issue } = item;
          // 既存 task がある issue は新規 worktree を作らず、その task の worktree に
          // 切り替える。terminal close で closed_by_user 化されている可能性があるため
          // 同 ghRef の upsert (reviveTaskForGhRef) で蘇生する (PR picker の既存
          // worktree hit ルートと同じ挙動)。
          const existing = item.existingTask;
          if (existing !== undefined) {
            const revived = await reviveTaskForGhRef({
              existingDir: existing.worktreeDir,
              ghTitle: issue.title,
              ghRef: ghRefForIssue(issue.number),
              errorLabel: "Failed to revive task for issue",
            });
            if (revived !== undefined) item.existingTask = revived;
            activateDir(existing.worktreeDir);
            return;
          }
          // worktree は default branch 起点、branch 名は timestamp（main 側の既定）。
          // issue 番号を branch 名に埋め込まないため、task を削除した後に同じ issue から
          // 作り直しても branch 名が衝突しない。
          //
          // issue タイトルを持つ task が Claude session 未起動状態 (sessionId 空) で
          // 一緒に永続化される。サイドバー行をクリックすると素の claude が起動して
          // SessionStart hook で attach される。
          const result = await tryCatch(
            rpcCreateTaskWorktree({
              dir,
              branch: "",
              startPoint: "",
              ghTitle: issue.title,
              ghRef: ghRefForIssue(issue.number),
            }),
          );
          if (!result.ok) {
            notify.error("Failed to create worktree for issue", result.error);
            return;
          }
          item.existingTask = result.value.task;
          // issue URL を prefill で渡し、claude の入力欄に事前挿入する (送信はされない)。
          openCreatedWorktree(result.value, { prefill: issue.url });
        };

        // viewer 取得失敗時は undefined。空文字に倒して picker dialog の "@me" filter UI
        // を degraded mode (filter 非表示) にする。
        // callback は async で、返す promise が処理完了 (成功 / 失敗を問わず) を表す。
        // 実行中の排他は dialog ではなくここ (コマンド層) が inFlightGhRefs で持つ。
        // dialog の状態は close / 開き直しで破棄されるため、通常選択 (close 後の
        // fire-and-forget 実行) 中に picker を開き直して同じ issue を選ぶと、別 timestamp
        // での重複 worktree / task 作成になる。dialog は同じ集合を参照して選択をブロック
        // するので通常ここには来ないが、ブロック反映前の競合窓で到達しうるため観察可能化
        // して弾く。
        setResult(gen, items, viewerLogin ?? "", async (item) => {
          if (inFlightGhRefs.has(item.refKey)) {
            notify.info(`Issue #${item.issue.number} is already being processed`);
            return;
          }
          inFlightGhRefs.add(item.refKey);
          const accepted = await tryCatch(acceptIssue(item));
          inFlightGhRefs.remove(item.refKey);
          if (!accepted.ok) {
            // acceptIssue は失敗を notify 済みで resolve する契約なので、ここに来るのは
            // 契約違反の throw = 真の未通知失敗。packaged では console が不可視のため、
            // ユーザーに surface するトーストで観察可能化する
            notify.error("Failed to process issue selection", accepted.error);
          }
        });
      })();

      return true;
    },
  });

  return dispose;
}
