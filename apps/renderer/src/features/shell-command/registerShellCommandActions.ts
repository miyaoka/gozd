/**
 * `gozd` shell コマンドを `~/.local/bin` に install / uninstall するコマンドを登録する。
 * VSCode の "Install 'code' command in PATH" と同じ思想だが、`~/.local/bin` を使うため
 * 権限昇格は不要。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";
import { rpcShellCommandInstall, rpcShellCommandUninstall } from "./rpc";

async function runInstall() {
  const notify = useNotificationStore();
  const result = await tryCatch(rpcShellCommandInstall());
  if (!result.ok) {
    notify.error("Failed to install gozd command", result.error);
    return;
  }
  const { source, target, alreadyInstalled, replaced } = result.value;
  if (alreadyInstalled) {
    notify.info(`gozd command is already installed at ${source}`);
    return;
  }
  if (replaced) {
    notify.info(`gozd command updated: ${source} -> ${target}`);
    return;
  }
  notify.info(`gozd command installed: ${source} -> ${target}`);
}

async function runUninstall() {
  const notify = useNotificationStore();
  const result = await tryCatch(rpcShellCommandUninstall());
  if (!result.ok) {
    notify.error("Failed to uninstall gozd command", result.error);
    return;
  }
  const { source, removed, notInstalled } = result.value;
  if (removed) {
    notify.info(`gozd command uninstalled: ${source}`);
    return;
  }
  if (notInstalled) {
    notify.info(`gozd command was not installed`);
    return;
  }
  // symlink は存在するが別の .app を指していた、または target を解決できなかったケース
  notify.info(`gozd command at ${source} was not removed (points to a different app)`);
}

/** コマンド登録。MainLayout で一度だけ呼び出す */
export function registerShellCommandActions(): () => void {
  const { register } = useCommandRegistry();
  const disposeInstall = register("shellCommand.install", {
    label: "Shell Command: Install 'gozd' command in PATH",
    handler: () => {
      void runInstall();
      return true;
    },
  });
  const disposeUninstall = register("shellCommand.uninstall", {
    label: "Shell Command: Uninstall 'gozd' command from PATH",
    handler: () => {
      void runUninstall();
      return true;
    },
  });
  return () => {
    disposeInstall();
    disposeUninstall();
  };
}
