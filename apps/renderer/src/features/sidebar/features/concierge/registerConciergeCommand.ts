/**
 * 窓口へ移るコマンド（Cmd+N）。窓口の project を選ぶのと同じで、前回の端末が残っていれば
 * それを出し、無ければ素のシェルを開く。Claude は自動では起動しない（docs/concierge.md）。
 */

import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { activateDir } from "../../../terminal";

export function registerConciergeCommand(): () => void {
  const registry = useCommandRegistry();
  const repoStore = useRepoStore();
  const notifications = useNotificationStore();

  return registry.register("workspace.concierge", {
    label: "Workspace: Open Concierge",
    keybinding: { key: "cmd+n" },
    handler: () => {
      const dir = repoStore.concierge?.rootDir;
      if (dir === undefined) {
        notifications.error("The concierge directory is not ready yet");
        return false;
      }
      activateDir(dir);
      return true;
    },
  });
}
