/**
 * native の `gozdOpen` push を購読し、ワークスペースに repo を登録する。
 *
 * 解決フロー（docs/workspace.md「プロジェクト管理」参照）:
 * - targetDir が既存 repo の worktrees に含まれる → 切替のみ
 * - 含まれない → 新規 repo として worktrees を fetch して `addRepo` → 切替
 */
import type { WorktreeEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted } from "vue";
import { useAppStore } from "../../shared/app";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { usePreviewStore } from "../preview";
import { useWorktreeStore } from "../worktree";
import { rpcGitWorktreeList } from "./rpc";

interface GozdOpenPayload {
  dir: string;
  /**
   * main 側 `openTarget.ts` の resolver は **ファイル指定のときだけ** selection を埋め、
   * その場合 `kind: "file"` 固定で送る（dir 指定時は selection 未指定）。renderer は
   * `kind` で分岐せず常に worktree 相対のファイルとして扱う契約。field を残すのは将来
   * `dir` 種別を追加する余地のため。判定 / mapping を増やすときは本コメントと
   * `openTarget.ts` の selection 生成箇所（`kind: "file"` リテラルを含むブロック）
   * を同時に更新する。
   */
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
