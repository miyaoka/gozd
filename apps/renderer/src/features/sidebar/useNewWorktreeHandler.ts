/**
 * main の `newWorktree` push を購読し、`gozd worktree new` で作られた worktree を開く。
 *
 * worktree と task の作成は main 側で完了している。ここは UI 反映だけを担い、PR / issue
 * picker と同じ後段（サイドバーに載せる → autostart / setup ヒント → ターミナル起動）を通す。
 *
 * 選択中の worktree は動かさない（docs/task.md の「エージェントから worktree を作る」）。
 *
 * この push の指示文は pull で取り直せない。worktree と Task はサイドバーの再取得で現れるが、
 * 指示文は push payload にしか存在しないため、UI 反映が失敗するとそこで失われる。失われた
 * ことを実行者もユーザーも知らないまま終わらせないよう、失敗はトーストに倒して指示文を
 * 添える（手で渡し直せる形で残す）。
 */
import type { NewWorktreePayload } from "@gozd/rpc";
import { onMounted, onUnmounted } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { notifyLostPrompt, openCreatedWorktree } from "../terminal";
import { ensureRepoRegistered } from "../worktree";

export function useNewWorktreeHandler() {
  const notifications = useNotificationStore();

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
      // async な失敗は listener の tryCatch では捕まらない（浮いた promise になる）。
      // ここで受けないと、worktree だけが残って指示文が黙って消える
      void handle(payload).catch((cause: unknown) => {
        notifications.error(`Could not open the created worktree at ${payload.dir}`, cause);
        notifyLostPrompt(notifications, payload.prompt);
      });
    });
  });
  onUnmounted(() => {
    dispose?.();
  });
}
