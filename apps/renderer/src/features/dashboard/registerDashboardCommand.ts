/**
 * Task ダッシュボードを開くコマンド。Cmd+K / コマンドパレットから開き、入力へ focus する。
 * task は repo プール全体から集めるため precondition を持たない (revive picker と同じ理由:
 * 選択中 repo の状態に依存しない)。
 */

import { useCommandRegistry, useContextKeys } from "../../shared/command";
import { useDashboard } from "./useDashboard";

export function registerDashboardCommand(): () => void {
  const registry = useCommandRegistry();
  const contextKeys = useContextKeys();
  const { show } = useDashboard();

  return registry.register("workspace.dashboard", {
    label: "Workspace: Task Dashboard",
    keybinding: { key: "cmd+k" },
    handler: () => {
      // 開いている間の再押下は no-op (file-picker と同流儀)
      if (contextKeys.get("dashboardVisible")) return true;
      show();
      return true;
    },
  });
}
