import {
  ShellCommandInstallRequest,
  ShellCommandInstallResponse,
  ShellCommandUninstallRequest,
  ShellCommandUninstallResponse,
} from "@gozd/proto";

import { rpc } from "../../shared/rpc";

export const rpcShellCommandInstall = (
  req: ShellCommandInstallRequest = ShellCommandInstallRequest.create(),
) => rpc("/shellCommand/install", req, ShellCommandInstallRequest, ShellCommandInstallResponse);

export const rpcShellCommandUninstall = (
  req: ShellCommandUninstallRequest = ShellCommandUninstallRequest.create(),
) =>
  rpc("/shellCommand/uninstall", req, ShellCommandUninstallRequest, ShellCommandUninstallResponse);
