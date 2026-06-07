import Foundation
import GozdProto

// `gozd` shell command (CLI) の install / uninstall RPC handler。`ShellCommandOps.*` への
// 薄いラッパー。

extension RpcDispatcher {
  func handleShellCommandInstall(_ body: Data) throws -> Data {
    _ = try Gozd_V1_ShellCommandInstallRequest(jsonUTF8Data: body)
    let result = try ShellCommandOps.install()
    var resp = Gozd_V1_ShellCommandInstallResponse()
    resp.source = result.source
    resp.target = result.target
    resp.alreadyInstalled = result.alreadyInstalled
    resp.replaced = result.replaced
    return try resp.jsonUTF8Data()
  }

  func handleShellCommandUninstall(_ body: Data) throws -> Data {
    _ = try Gozd_V1_ShellCommandUninstallRequest(jsonUTF8Data: body)
    let result = try ShellCommandOps.uninstall()
    var resp = Gozd_V1_ShellCommandUninstallResponse()
    resp.source = result.source
    resp.removed = result.removed
    resp.notInstalled = result.notInstalled
    return try resp.jsonUTF8Data()
  }
}
