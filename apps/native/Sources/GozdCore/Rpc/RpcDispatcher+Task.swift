import Foundation
import GozdProto

// Task store の RPC handler。`tasks.{add,setTerminalTitle,setUserTitle,remove,resumableSessionIds}`
// への薄いラッパー。task ≠ Claude session の設計上、task は PR/issue/手動操作で作られ、
// Claude session は task に attach する短命属性 (attachSession / detachSession) として扱う。
// session 紐付けは `RpcDispatcher+ClaudeSession.swift` 側 (`applyClaudeSessionHook` /
// `handleClaudeSessionRemoveByPty`) が担当する。

extension RpcDispatcher {
  // git 非依存で tasks.json だけを読む高速経路。renderer が起動直後、worktree キャッシュから
  // 描画したカードに task 行を即埋めるために使う (rpcGitWorktreeList の git 部分を待たない)。
  func handleTaskList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskListRequest(jsonUTF8Data: body)
    let list = try await tasks.list(dir: req.dir)
    var resp = Gozd_V1_TaskListResponse()
    resp.tasks = list
    return try resp.jsonUTF8Data()
  }

  func handleTaskAdd(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskAddRequest(jsonUTF8Data: body)
    let task = try await tasks.add(
      dir: req.dir,
      ghTitle: req.ghTitle,
      worktreeDir: req.worktreeDir,
      ghRef: req.hasGhRef ? req.ghRef : nil
    )
    var resp = Gozd_V1_TaskAddResponse()
    resp.task = task
    return try resp.jsonUTF8Data()
  }

  func handleTaskSetTerminalTitle(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskSetTerminalTitleRequest(jsonUTF8Data: body)
    let task = try await tasks.setTerminalTitle(
      dir: req.dir, id: req.id, terminalTitle: req.terminalTitle)
    var resp = Gozd_V1_TaskSetTerminalTitleResponse()
    resp.task = task
    return try resp.jsonUTF8Data()
  }

  func handleTaskSetUserTitle(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskSetUserTitleRequest(jsonUTF8Data: body)
    let task = try await tasks.setUserTitle(dir: req.dir, id: req.id, userTitle: req.userTitle)
    var resp = Gozd_V1_TaskSetUserTitleResponse()
    resp.task = task
    return try resp.jsonUTF8Data()
  }

  func handleTaskRemove(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskRemoveRequest(jsonUTF8Data: body)
    try await tasks.remove(dir: req.dir, id: req.id)
    return try Gozd_V1_TaskRemoveResponse().jsonUTF8Data()
  }

  /// 指定 dir で resume 可能な Claude セッションの session_id 一覧を返す。renderer の
  /// visit() が未訪問 worktree の初回オープン時に呼ぶ。導出ロジック (filter 条件) は
  /// `TaskStore.resumableSessionIds` が SSOT として持つ。dead session が混じり得るが
  /// `claude --resume` のエラー終了を resume 失敗検出経路 (`handleClaudeSessionRemoveByPty`)
  /// が片付ける (pure read)。
  func handleResumableSessionList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_ResumableSessionListRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_ResumableSessionListResponse()
    resp.sessionIds = try await tasks.resumableSessionIds(dir: req.dir)
    return try resp.jsonUTF8Data()
  }
}
