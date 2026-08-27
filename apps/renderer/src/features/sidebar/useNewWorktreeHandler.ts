/**
 * main の `newWorktree` push を購読し、`gozd worktree new` で作られた worktree を開く。
 *
 * worktree と task の作成は main 側で完了している。ここは UI 反映だけを担い、PR / issue
 * picker と同じ後段（サイドバーに載せる → autostart / setup ヒント → activate）を通す。
 *
 * push を取りこぼしても worktree は実在し、サイドバーの再取得で現れる。復旧不能になるのは
 * claude の autostart だけで、その場合はサイドバーの task 行クリックで起動できる。
 */
import type { NewWorktreePayload } from "@gozd/rpc";
import { onMounted, onUnmounted } from "vue";
import { onMessage } from "../../shared/rpc";
import { openCreatedWorktree } from "../terminal";
import { ensureRepoRegistered } from "../worktree";

export function useNewWorktreeHandler() {
  async function handle(payload: NewWorktreePayload) {
    const { prefill, repoName, ...created } = payload;
    // 別ウィンドウで開いていない repo に対しても `gozd worktree new --dir` は撃てる。
    // repo ごと未登録なら先に載せる（登録済みなら no-op）
    await ensureRepoRegistered({
      rootDir: created.rootDir,
      openDir: created.rootDir,
      repoName,
      isGitRepo: true,
    });
    openCreatedWorktree(created, prefill);
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
