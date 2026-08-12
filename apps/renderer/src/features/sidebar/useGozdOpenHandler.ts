/**
 * native の `gozdOpen` push を購読し、ワークスペースに repo を登録する。
 *
 * 解決フロー（docs/workspace.md 参照）:
 * - targetDir が既存 repo の worktrees に含まれる → 切替のみ
 * - 含まれない → 新規 repo として worktrees を fetch して `addRepo` → 切替
 */
import type { GozdOpenPayload, WorktreeEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted } from "vue";
import { useAppStore } from "../../shared/app";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { usePreviewStore } from "../preview";
import { rpcGitWorktreeList, useWorktreeStore } from "../worktree";

export function useGozdOpenHandler() {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
  const previewStore = usePreviewStore();
  const appStore = useAppStore();
  const notify = useNotificationStore();

  async function handle(payload: GozdOpenPayload) {
    const { dir, selection, channel, repoName, isGitRepo, switchToDir, error } = payload;
    if (channel) {
      appStore.setChannel(channel);
    }
    if (error !== undefined && error !== "") {
      notify.error("Failed to resolve git binary", error);
    }
    const targetDir = switchToDir !== "" ? switchToDir : dir;
    // 空 relPath の selection は未指定として扱う（openTarget.ts の payload 契約）
    const sel = selection !== undefined && selection.relPath !== "" ? selection : undefined;

    const owning = repoStore.findRepoOwning(targetDir);
    if (owning === undefined) {
      let worktrees: WorktreeEntry[] = [];
      if (isGitRepo) {
        const result = await tryCatch(rpcGitWorktreeList({ dir }));
        if (result.ok) {
          worktrees = result.value.worktrees;
        } else {
          notify.error("Failed to fetch repo data", result.error);
        }
      }
      repoStore.addRepo({ rootDir: dir, repoName, isGitRepo, worktrees });
    } else {
      // プールには居るがアクティブ repo list に無い repo を開いた場合、今見ている
      // リストに現れないと「開いたのに何も起きない」ため、末尾に追加して可視化する
      repoStore.ensureInActiveRepoList(owning.rootDir);
    }

    worktreeStore.setOpen(targetDir);
    // CLI 経路は「常に open」契約。同一 path の再 open でも閉じない（[docs/preview.md] の決定表参照）。
    // setOpen → forceSelect の順で呼ぶことで「dir 切替で preview を一旦 close → 続けて新ファイルで再 open」
    // のシーケンスが usePreviewStore 内部の dir watch（flush:'sync'）との組み合わせで成立する。
    //
    // `lineNumber` 未指定は `0` で表現される契約のため、1-based の有効値に正規化する。
    // `0` は「未指定」として undefined に倒す。
    if (sel) {
      const lineNumber = sel.lineNumber > 0 ? sel.lineNumber : undefined;
      previewStore.forceSelect({ kind: "worktreeRelative", relPath: sel.relPath }, lineNumber);
    }
  }

  let dispose: (() => void) | undefined;
  onMounted(() => {
    dispose = onMessage<GozdOpenPayload>("gozdOpen", (payload) => {
      void handle(payload);
    });
  });
  onUnmounted(() => {
    dispose?.();
  });
}
