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
import {
  reviveTaskForGhRef,
  rpcCreateWorktree,
  rpcGitDefaultBranch,
  rpcTaskAdd,
} from "../../../sidebar";
import { useTerminalStore } from "../../../terminal";
import { generateTimestamp, useWorktreeStore } from "../../../worktree";
import { buildTaskIndexByGhRef, ghRefKey } from "../../taskIndexByGhRef";
import { fetchViewer, ghErrorMessage } from "../pr-picker";
import { rpcGitIssueList } from "./rpc";
import { useIssuePicker } from "./useIssuePicker";
import type { IssuePickerItem } from "./useIssuePicker";

export function registerIssueCommand(): () => void {
  const registry = useCommandRegistry();
  const { open, setResult, hide } = useIssuePicker();
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const repoStore = useRepoStore();

  /** 並行作成中の branch (= timestamp) 名。branch 名が秒精度 timestamp のため、連続選択
   * (Shift 選択) で同一秒内に別 issue を accept すると同名 branch の worktree add が競合する。
   * in-flight を記録して衝突する accept だけブロックする (完了待ちの全体ブロックはしない)。 */
  const inFlightBranches = new Set<string>();

  /** timestamp branch で worktree + task を作成して切り替える。失敗は notify 済みで resolve
   * する (throw しない) ため、呼び出し側の inFlightBranches の後始末が finally なしで成立する。 */
  async function createWorktreeForIssue(params: {
    item: IssuePickerItem;
    rootDir: string;
    timestamp: string;
    startPoint: string;
  }): Promise<void> {
    const { item, rootDir, timestamp, startPoint } = params;
    const { issue } = item;
    const result = await tryCatch(
      rpcCreateWorktree({
        dir: rootDir,
        worktreeDir: timestamp,
        branch: timestamp,
        startPoint,
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
        ghTitle: issue.title,
        worktreeDir: result.value.dir,
        ghRef: ghRefForIssue(issue.number),
      }),
    );
    if (!taskResult.ok) {
      notify.error("Failed to create task for issue", taskResult.error);
      return;
    }
    item.existingTask = taskResult.value.task;
    repoStore.requestRefresh(rootDir);
    // 直後の setOpen で visit が走り初期 leaf が作られる前に autostart ヒントを残す。
    // これで visit が初期 leaf に素の `claude` 起動を仕込み、SessionStart hook で
    // 上で作成した task に attach される。後追いクリック起動の二重 leaf を防ぐ。
    // issue URL を prefill で渡し、claude の入力欄に事前挿入する (送信はされない)。
    terminalStore.requestNewClaudeSession(result.value.dir, issue.url);
    terminalStore.setPreferredSetup(result.value.dir, result.value.setupScript);
    terminalStore.viewMode = "wt";
    worktreeStore.setOpen(result.value.dir);
  }

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
        const taskByGhRef = buildTaskIndexByGhRef(repoStore.findRepoOwning(dir)?.worktrees ?? []);
        const items = issuesRes.issues.map(
          (issue): IssuePickerItem => ({
            issue,
            existingTask: taskByGhRef.get(ghRefKey(ghRefForIssue(issue.number))),
          }),
        );

        // この callback は IssuePickerDialog 側で close() 後に呼ばれるため、
        // 連打による再エントリは dialog の DOM 除去で塞がれている。`isCreating` 相当のガードは不要。
        // viewer 取得失敗時は undefined。空文字に倒して picker dialog の "@me" filter UI
        // を degraded mode (filter 非表示) にする。
        // callback は async で、返す promise が処理完了 (成功 / 失敗を問わず) を表す。
        // dialog は連続選択 (Shift 選択) 時にこの完了を待って次の選択を解禁する。
        // 完了時に item.existingTask へ task を書き戻す (item は dialog が picker.items
        // (reactive) から渡す proxy) ことで、開いたままの一覧の行が作成済み表示に変わり、
        // 同 issue の再選択が既存切り替えルートに倒れる。
        setResult(gen, items, viewerLogin ?? "", async (item) => {
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
            terminalStore.viewMode = "wt";
            worktreeStore.setOpen(existing.worktreeDir);
            return;
          }
          // 新規 worktree は default branch を起点に作る。main 側で `origin/HEAD` を
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
          // 埋め込まないため、task を削除した後に同じ issue から作り直しても branch 名が
          // 衝突しない。
          const timestamp = generateTimestamp();
          if (inFlightBranches.has(timestamp)) {
            notify.info(
              `Branch name ${timestamp} collides with an in-flight creation; retry shortly`,
            );
            return;
          }
          inFlightBranches.add(timestamp);
          await createWorktreeForIssue({
            item,
            rootDir,
            timestamp,
            startPoint: branchResult.value.branch,
          });
          inFlightBranches.delete(timestamp);
        });
      })();

      return true;
    },
  });

  return dispose;
}
