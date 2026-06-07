import Foundation
import GozdProto

// worktree mutation の RPC handler。`WorktreeOps.*` への薄いラッパー + 削除時の task store
// cascade clean。worktree 物理削除時に `tasks.removeByWorktree` を併走させて孤児 task が
// `tasks.json` に残らないようにする (`handleClaudeSessionRemoveByPty` と対称)。

extension RpcDispatcher {
  func handleCreateWorktree(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_CreateWorktreeRequest(jsonUTF8Data: body)
    let startPoint = req.startPoint.isEmpty ? nil : req.startPoint
    let info = try await WorktreeOps.createWorktree(
      dir: req.dir, worktreeDir: req.worktreeDir, branch: req.branch, startPoint: startPoint)
    var resp = Gozd_V1_CreateWorktreeResponse()
    var entry = Gozd_V1_WorktreeEntry()
    entry.path = info.path
    entry.head = info.head
    entry.branch = info.branch ?? ""
    entry.isMain = info.isMain
    resp.worktree = entry
    resp.dir = info.path
    return try resp.jsonUTF8Data()
  }

  func handleWorktreeRemove(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitWorktreeRemoveRequest(jsonUTF8Data: body)
    try await WorktreeOps.removeWorktree(dir: req.dir, path: req.path, force: req.force)
    // worktree 物理削除に Task の片付けも連動させる。task は worktreeDir に紐づく
    // 永続オブジェクトなので、放置すると `tasks.json` に孤児 Task が残り、サイドバーに
    // ゾンビ行が出る (handleClaudeSessionRemoveByPty と対称)。projectKey 解決は req.dir
    // (main repo dir、削除されない側) から行う。req.path は物理削除済みなので anchor に
    // すると projectKey が変わって別ファイルを参照する。失敗は notify でユーザーに伝える。
    do {
      try await tasks.removeByWorktree(dir: req.dir, worktreePath: req.path)
    } catch {
      StderrLog.write(tag: "TaskStore", "removeByWorktree failed: \(error)")
      onNotify(
        "error", "task-store", "Failed to clean up tasks after worktree removal",
        String(describing: error), req.dir)
    }
    return try Gozd_V1_GitWorktreeRemoveResponse().jsonUTF8Data()
  }
}
