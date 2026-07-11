/**
 * ファイル検索コマンド（Go to File）。
 * Cmd+P / コマンドパレットから file picker が開き、worktree 内のファイルを
 * あいまい検索で選んで preview で開く。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry, useContextKeys } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { usePreviewStore } from "../../../preview";
import { useWorktreeStore } from "../../../worktree";
import { rpcGitLsFiles } from "./rpc";
import { useFilePicker } from "./useFilePicker";

export function registerFilePickerCommand(): () => void {
  const registry = useCommandRegistry();
  const { open, setResult, hide } = useFilePicker();
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const previewStore = usePreviewStore();
  const contextKeys = useContextKeys();

  return registry.register("workspace.goToFile", {
    label: "Workspace: Go to File",
    precondition: "isGitRepo",
    handler: () => {
      // 表示中の Cmd+P 再押下は no-op（VS Code の Quick Open と同じ現状維持）。
      // 再 open() すると items がクリアされ loading フラッシュ + 無駄な再列挙になる。
      if (contextKeys.get("filePickerVisible")) return true;
      void (async () => {
        const dir = worktreeStore.dir;
        if (dir === undefined) return;
        // fetch 前に picker を loading で開き、列挙の待ち時間を可視化する。
        // gen は stale 応答（open 後に別 open で開き直された場合）を捨てるための世代。
        const gen = open();
        const result = await tryCatch(rpcGitLsFiles({ dir }));
        if (!result.ok) {
          if (hide(gen)) notify.error("Failed to list files", result.error);
          return;
        }
        // 選んだファイルは常に開く（forceSelect）。requestSelect の同一 path トグル
        // close は「明示的にこのファイルを見たい」という picker の intent と合わない。
        setResult(gen, result.value.files, "", (relPath) => {
          // forceSelect は relPath を live な worktreeStore.dir に対して解決する。
          // modal 表示中でも gozdOpen push 等のプログラム的 dir 切替は起こりうるため、
          // 列挙時の dir から変わっていたら別 worktree への誤解決を避けて no-op に倒す
          // （requestSelect / forceSelect の「selection が成立しない入力は no-op」契約と同じ向き）。
          if (worktreeStore.dir !== dir) return;
          previewStore.forceSelect({ kind: "worktreeRelative", relPath });
        });
      })();

      return true;
    },
  });
}
