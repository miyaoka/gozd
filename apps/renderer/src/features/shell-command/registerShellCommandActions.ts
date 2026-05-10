/**
 * `gozd` shell コマンドを `~/.local/bin` に install / uninstall するコマンドを登録する。
 * VSCode の "Install 'code' command in PATH" と同じ思想だが、`~/.local/bin` を使うため
 * 権限昇格は不要。
 *
 * dev `.app` には `Resources/app/bin/gozd` が同梱されないため、Vite dev mode では登録しない。
 * Vite の dev / prod 判定は build 時に静的に解決される（`import.meta.env.DEV`）。
 */

import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";
import { rpcShellCommandInstall, rpcShellCommandUninstall } from "./rpc";

/** コマンド登録。MainLayout で一度だけ呼び出す。dev では何も登録せず no-op を返す */
export function registerShellCommandActions(): () => void {
  if (import.meta.env.DEV) return () => {};

  const { register } = useCommandRegistry();
  const notify = useNotificationStore();

  async function runInstall() {
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
