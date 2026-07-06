/**
 * filer のコマンドを登録する。MainLayout で一度だけ呼び出す。
 *
 * `filer.copyFile` はツリーで選択中のファイルを OS クリップボードにファイル参照として
 * コピーする（cmd+c、when: filerFocus）。snapshot mode ではコピーしない: snapshot の
 * ファイルはディスク上に実体が無く、パスを載せると「見ていた過去の内容」ではなく
 * 最新の worktree 内容が paste される誤読を生む。無音で不発にすると「コピーした」という
 * 誤認 + 古いクリップボード内容の paste 事故につながるため、toast で拒否を明示する。
 */
import { useCommandRegistry } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";
import { useGitGraphStore } from "../git-graph";
import { joinAbsRel, useWorktreeStore } from "../worktree";
import { copyFileToOsClipboard } from "./copyFileToOsClipboard";

export function registerFilerCommands(): () => void {
  const { register } = useCommandRegistry();
  const notify = useNotificationStore();
  const worktreeStore = useWorktreeStore();
  const gitGraphStore = useGitGraphStore();

  return register("filer.copyFile", {
    label: "Filer: Copy File",
    handler: () => {
      const dir = worktreeStore.dir;
      const relPath = worktreeStore.selectedRelPath;
      // 選択なしは未処理として返し、cmd+c をデフォルト動作（テキストコピー等）に譲る
      if (dir === undefined || relPath === undefined) return false;
      if (gitGraphStore.isSnapshotMode) {
        notify.warning("Cannot copy files from a snapshot");
        return true;
      }
      void copyFileToOsClipboard(joinAbsRel(dir, relPath), relPath);
      return true;
    },
  });
}
