import Foundation
import GozdProto

// サーバー検出 (issue #768) 系 RPC handler。
// - /server/list: PortScanner の直近 snapshot を pull (renderer mount 時の hydrate)
// - /window/setServerPanelOpen: パネル開閉状態を titlebar トグルボタンにミラー

extension RpcDispatcher {
  func handleServerList(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_ServerListRequest(jsonUTF8Data: body)
    let snapshot = await portScanner.currentSnapshot()
    var resp = Gozd_V1_ServerListResponse()
    resp.servers = snapshot.map { Self.protoEntry(from: $0) }
    return try resp.jsonUTF8Data()
  }

  func handleWindowSetServerPanelOpen(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_WindowSetServerPanelOpenRequest(jsonUTF8Data: body)
    let open = req.open
    await MainActor.run {
      ServerPanelContext.shared.isOpen = open
    }
    return try Gozd_V1_WindowSetServerPanelOpenResponse().jsonUTF8Data()
  }

  /// DetectedServer を proto ServerEntry に写す。push 経路 (AppRuntime の手組み dict) と
  /// 同じ wire shape を保つ唯一の変換点。
  static func protoEntry(from server: DetectedServer) -> Gozd_V1_ServerEntry {
    var entry = Gozd_V1_ServerEntry()
    entry.pid = server.pid
    entry.name = server.name
    entry.ports = server.ports.map { UInt32($0) }
    entry.attribution = protoAttribution(from: server.attribution)
    entry.worktreePath = server.worktreePath
    entry.ptyID = server.ptyId
    return entry
  }

  static func protoAttribution(
    from attribution: DetectedServer.Attribution
  ) -> Gozd_V1_ServerAttribution {
    switch attribution {
    case .live: return .live
    case .orphaned: return .orphaned
    case .external: return .external
    }
  }
}
