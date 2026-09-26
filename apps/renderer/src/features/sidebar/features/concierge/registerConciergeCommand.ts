/**
 * 窓口で新しい Claude を起動するコマンド（Cmd+N）。窓口を選び、新しい端末で Claude を起動する
 * （docs/concierge.md）。窓口を開いている最中に押しても、そのたびに新しい端末で起動する。
 * 既存の窓口の端末は閉じない。
 */

import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { activateDir, useTerminalStore } from "../../../terminal";

export function registerConciergeCommand(): () => void {
  const registry = useCommandRegistry();
  const repoStore = useRepoStore();
  const terminalStore = useTerminalStore();
  const notifications = useNotificationStore();

  return registry.register("workspace.concierge", {
    label: "Workspace: New Concierge Session",
    keybinding: { key: "cmd+n" },
    handler: () => {
      const dir = repoStore.concierge?.rootDir;
      if (dir === undefined) {
        notifications.error("The concierge directory is not ready yet");
        return false;
      }
      // 起動の指示は選択より先に置く。未訪問の dir は、選択が駆動する visit がこの指示を
      // 読んで最初の端末で Claude を起動する
      terminalStore.requestNewClaudeSession(dir);
      activateDir(dir);
      return true;
    },
  });
}
