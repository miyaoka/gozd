/**
 * Issue 選択コマンド。
 * コマンドパレットから "Workspace: New Worktree from Issue" を実行すると issue picker が開き、
 * issue を選択して worktree を作成する。同じ issue から何本でも作る。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { ghErrorMessage } from "../../../github-item";
import { openCreatedWorktree } from "../../../terminal";
import { rpcCreateWorktree, useWorktreeStore } from "../../../worktree";
import { inFlightKey, useInFlightItems } from "../../inFlightItems";
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
  const inFlightItems = useInFlightItems();

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

        const owningRepo = repoStore.findRepoOwning(dir);
        const items = issuesRes.issues.map((issue): IssuePickerItem => ({
          issue,
          refKey: inFlightKey(owningRepo?.rootDir ?? dir, "issue", issue.number),
        }));

        // accept の実体。失敗はすべて notify 済みで resolve する (throw しない) 契約。
        const acceptIssue = async (item: IssuePickerItem): Promise<void> => {
          const { issue } = item;
          // 同じ issue から作った worktree があっても新規に作る。branch は timestamp なので
          // 同じ issue に何本でも worktree を持てる（別のアプローチを並行して試す用途）。
          // 既存の作業へ戻る導線はサイドバーのセッション行が担う。
          // worktree は default branch 起点、branch 名は timestamp（main 側の既定）。
          const result = await tryCatch(rpcCreateWorktree({ dir, branch: "", startPoint: "" }));
          if (!result.ok) {
            notify.error("Failed to create worktree for issue", result.error);
            return;
          }
          // issue URL を prefill で渡し、claude の入力欄に事前挿入する (送信はされない)。
          openCreatedWorktree(result.value, { prefill: issue.url }, "foreground");
        };

        // viewer 取得失敗時は undefined。空文字に倒して picker dialog の "@me" filter UI
        // を degraded mode (filter 非表示) にする。
        // callback は async で、返す promise が処理完了 (成功 / 失敗を問わず) を表す。
        // **実行中の判定はここが唯一の関門**。dialog は先回りしない (先回りすると下の
        // 通知ごと握りつぶし、操作が無反応で消える)。したがってこの分岐は稀な競合窓の
        // 保険ではなく、実行中の行を選んだときの常用経路であり、消すと連打がそのまま
        // 本数になる。dialog の状態は close / 開き直しで破棄されるため、判定を
        // inFlightItems (module singleton) に置いて picker セッションを跨がせる。
        setResult(gen, items, viewerLogin ?? "", async (item) => {
          if (inFlightItems.has(item.refKey)) {
            notify.info(`Issue #${item.issue.number} is already being processed`);
            return;
          }
          inFlightItems.add(item.refKey);
          const accepted = await tryCatch(acceptIssue(item));
          inFlightItems.remove(item.refKey);
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
