/**
 * PR 選択コマンド。
 * コマンドパレットから "Workspace: New Worktree from Pull Request" を実行すると PR picker が開き、
 * PR を選択して worktree を作成する。既にブランチの worktree が存在する場合はそちらに切り替える。
 */

import type { GitPullRequest } from "@gozd/rpc";
import { ghRefForPr } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { ghErrorMessage } from "../../../github-item";
import { reviveTaskForGhRef } from "../../../task";
import { activateDir, openCreatedWorktree } from "../../../terminal";
import {
  rpcCreateTaskWorktree,
  rpcGitPrList,
  rpcGitWorktreeList,
  useWorktreeStore,
} from "../../../worktree";
import type { ListPickerPage } from "../../createListPicker";
import { inFlightKey, useInFlightGhRefs } from "../../inFlightGhRefs";
import { buildTaskIndexByGhRef, ghRefKey } from "../../taskIndexByGhRef";
import { usePrPicker } from "./usePrPicker";
import type { PrPickerItem } from "./usePrPicker";
import { fetchViewer } from "./useViewer";

export function registerPrCommand(): () => void {
  const registry = useCommandRegistry();
  const { open, setResult, setTotalCount, setPageSource, hide } = usePrPicker();
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
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
        const toItems = (prs: GitPullRequest[]): PrPickerItem[] =>
          prs.map((pr) => ({
            pr,
            existingTask: taskByGhRef.get(ghRefKey(ghRefForPr(pr.number))),
            refKey: inFlightKey(owningRepo?.rootDir ?? dir, ghRefForPr(pr.number)),
          }));
        const items = toItems(prsRes.prs);

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
            activateDir(existingDir);
            return;
          }
          // 新規 worktree 作成。branch は PR の head ref、起点は remote 側の同 ref。
          // PR タイトルを持つ task が Claude session 未起動状態 (sessionId 空) で一緒に
          // 永続化され、初期 leaf で素の claude を autostart して SessionStart hook で
          // attach される。失敗時は autostart を抑止し、ユーザーに復旧を委ねる
          // (再選択で wtByBranch hit に倒れる)。
          const result = await tryCatch(
            rpcCreateTaskWorktree({
              dir,
              branch: pr.headRef,
              startPoint: `origin/${pr.headRef}`,
              ghTitle: pr.title,
              ghRef: ghRefForPr(pr.number),
            }),
          );
          if (!result.ok) {
            notify.error("Failed to create worktree for pull request", result.error);
            return;
          }
          item.existingTask = result.value.task;
          // PR URL を prefill で渡し、claude の入力欄に事前挿入する (送信はされない)。
          openCreatedWorktree(result.value, { prefill: pr.url });
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

        // 総数は 1 ページで収まった取得でも意味を持つ（表示は「絞り込み後 / 取得済み / 総数」）
        setTotalCount(gen, prsRes.totalCount);

        // 続きは picker が要求する（契約は docs/git.md の「PR の取得は問いごとに分ける」）
        if (prsRes.nextCursor !== "") {
          setPageSource(
            gen,
            nextPageFetcher(dir, prsRes.nextCursor, toItems, (message, cause) =>
              notify.error(message, cause),
            ),
          );
        }
      })();

      return true;
    },
  });

  return dispose;
}

/**
 * 次のページを取る関数を作る。カーソルはここに閉じ込め、呼ばれるたびに 1 ページ進める。
 *
 * 取り切りも失敗も `done: true` で打ち切る。失敗は通知する: 打ち切られた一覧は見た目が正常なので、
 * 黙って止めると「これで全部」と読める。
 */
function nextPageFetcher(
  dir: string,
  firstCursor: string,
  toItems: (prs: GitPullRequest[]) => PrPickerItem[],
  onError: (message: string, cause?: unknown) => void,
): () => Promise<ListPickerPage<PrPickerItem>> {
  let cursor = firstCursor;
  return async () => {
    const result = await tryCatch(rpcGitPrList({ dir, after: cursor }));
    if (!result.ok) {
      onError("Failed to load more pull requests", result.error);
      return { items: [], done: true };
    }
    const res = result.value;
    if (!res.ok) {
      onError(
        ghErrorMessage(res.errorKind, "Failed to load more pull requests"),
        res.errorDetail || undefined,
      );
      return { items: [], done: true };
    }
    // 最終ページは「項目があり、かつこれで終わり」。done を同時に返さないと、同じカーソルを
    // もう一度引いて同じページを二重に足す
    cursor = res.nextCursor;
    return { items: toItems(res.prs), done: res.nextCursor === "" };
  };
}
