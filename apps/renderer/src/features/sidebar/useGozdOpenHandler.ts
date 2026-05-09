/**
 * native の `gozdOpen` push を購読し、ワークスペースに repo を登録する。
 *
 * 解決フロー（docs/workspace.md「プロジェクト管理」参照）:
 * - targetDir が既存 repo の worktrees に含まれる → 切替のみ
 * - 含まれない → 新規 repo として worktrees / freeBranches を fetch して `addRepo` → 切替
 */
import type { WorktreeEntry } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted } from "vue";
import { useAppStore } from "../../shared/app";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { useWorktreeStore } from "../worktree";
import { rpcGitBranchList, rpcGitWorktreeList } from "./rpc";

interface GozdOpenPayload {
  dir: string;
  selection?: { kind: string; relPath: string; lineNumber: number };
  channel: string;
  repoName: string;
  isGitRepo: boolean;
  switchToDir: string;
}

export function useGozdOpenHandler() {
  const repoStore = useRepoStore();
  const worktreeStore = useWorktreeStore();
  const appStore = useAppStore();
  const notify = useNotificationStore();

  async function handle(payload: GozdOpenPayload) {
    const { dir, selection, channel, repoName, isGitRepo, switchToDir } = payload;
    if (channel) {
      appStore.setChannel(channel);
    }
    const targetDir = switchToDir !== "" ? switchToDir : dir;
    // proto3 scalar では undefined が表現できないため、空 selection は未指定として扱う
    const sel = selection !== undefined && selection.relPath !== "" ? selection : undefined;

    if (repoStore.findRepoOwning(targetDir) === undefined) {
      let worktrees: WorktreeEntry[] = [];
      let freeBranches: string[] = [];
      if (isGitRepo) {
        const result = await tryCatch(
          Promise.all([rpcGitWorktreeList({ dir }), rpcGitBranchList({ dir })]),
        );
        if (result.ok) {
          const [wtRes, branchRes] = result.value;
          worktrees = wtRes.worktrees;
          const wtBranches = new Set(worktrees.map((wt) => wt.branch).filter(Boolean));
          freeBranches = branchRes.branches.filter((b) => !wtBranches.has(b));
        } else {
          notify.error("Failed to fetch repo data", result.error);
        }
      }
      repoStore.addRepo({ rootDir: dir, repoName, isGitRepo, worktrees, freeBranches });
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
