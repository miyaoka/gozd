import type { ShellCommandInstallResponse, ShellCommandUninstallResponse } from "@gozd/rpc";

import { rpc } from "../../shared/rpc";

export const rpcShellCommandInstall = () =>
  rpc<ShellCommandInstallResponse>("/shellCommand/install", {});

export const rpcShellCommandUninstall = () =>
  rpc<ShellCommandUninstallResponse>("/shellCommand/uninstall", {});
