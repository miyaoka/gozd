/**
 * native の `gozdOpen` push を購読し、ワークスペースに repo を登録する。
 *
 * 解決フロー（docs/workspace.md「プロジェクト管理」参照）:
 * - targetDir が既存 repo の worktrees に含まれる → 切替のみ
 * - 含まれない → 新規 repo として worktrees を fetch して `addRepo` → 切替
 */
import type { WorktreeEntry } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted } from "vue";
import { useAppStore } from "../../shared/app";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { useWorktreeStore } from "../worktree";
import { rpcGitWorktreeList } from "./rpc";

interface GozdOpenPayload {
  dir: string;
  selection?: { kind: string; relPath: string; lineNumber: number };
  channel: string;
  repoName: string;
  isGitRepo: boolean;
  switchToDir: string;
  /**
   * native 側で git バイナリの解決自体に失敗した場合（`GitError.launchFailed`）に積まれる。
   * `commandFailed`（probeDir が git 管理外 / detached HEAD 等）は積まず、`isGitRepo = false`
   * として既存挙動を維持する。両者を区別することで、ユーザーシェル経由でも git を解決できない
   * 病的環境を「git repo ではない」と silent に化けさせず notify.error で可視化する。
   */
  error?: string;
}

export function useGozdOpenHandler() {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
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
    // proto3 scalar では undefined が表現できないため、空 selection は未指定として扱う
    const sel = selection !== undefined && selection.relPath !== "" ? selection : undefined;

    if (repoStore.findRepoOwning(targetDir) === undefined) {
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
    }

    worktreeStore.setOpen(targetDir, { selection: sel });
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
