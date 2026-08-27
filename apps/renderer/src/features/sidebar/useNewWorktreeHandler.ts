/**
 * main の `newWorktree` push を購読し、`gozd worktree new` で作られた worktree を開く。
 *
 * worktree と task の作成は main 側で完了している。ここは UI 反映だけを担い、PR / issue
 * picker と同じ後段（サイドバーに載せる → autostart / setup ヒント → ターミナル起動）を通す。
 *
 * 選択中の worktree は動かさない（docs/task.md の「エージェントから worktree を作る」）。
 *
 * push を取りこぼしても worktree と Task は実在し、サイドバーの再取得で現れる。戻らないのは
 * 指示文で、Task に永続化していないためこの push にしか乗っていない。task 行のクリックで
 * 起動できるのは素の claude までで、指示は渡らない。
 */
import type { NewWorktreePayload } from "@gozd/rpc";
import { onMounted, onUnmounted } from "vue";
import { onMessage } from "../../shared/rpc";
import { openCreatedWorktree } from "../terminal";
import { ensureRepoRegistered } from "../worktree";

export function useNewWorktreeHandler() {
  async function handle(payload: NewWorktreePayload) {
    const { prompt, repoName, ...created } = payload;
    // 別ウィンドウで開いていない repo に対しても `gozd worktree new --dir` は実行できる。
    // repo ごと未登録なら先に載せる（登録済みなら no-op）
    await ensureRepoRegistered({
      rootDir: created.rootDir,
      openDir: created.rootDir,
      repoName,
      isGitRepo: true,
    });
    // 指示は引数で渡す。切り出した相手は起動と同時に走り出す
    openCreatedWorktree(created, { prompt }, "background");
  }

  let dispose: (() => void) | undefined;
  onMounted(() => {
    dispose = onMessage<NewWorktreePayload>("newWorktree", (payload) => {
      void handle(payload);
    });
  });
  onUnmounted(() => {
    dispose?.();
  });
}
