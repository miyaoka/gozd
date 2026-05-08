import CryptoKit
import Foundation
import GozdProto

// プロジェクト固有 Task の永続化（`~/.config/gozd/projects/<projectKey>/tasks.json`）。
//
// 設計判断:
//
// 1. **projectKey は dir realpath の SHA-256 先頭 12 文字 + repoName**。
//    旧 desktop 実装と互換。`~/.config/gozd/projects/<repoName>-<hash>/`。
//
// 2. **永続化形式は proto JSON**。AppStateStore / AppConfigStore と同流儀。
//    `TaskList` ラッパーを介して `tasks` を array として保存する。
//
// 3. **actor**。読み書きが直列化されるよう actor 化。複数 RPC が並行で書きにくる
//    シナリオでファイルが破損するのを防ぐ。
public actor TaskStore {
  private let configDir: String

  public init(configDir: String) {
    self.configDir = configDir
  }

  public func list(dir: String) throws -> [Gozd_V1_Task] {
    return try loadFile(for: dir).tasks
  }

  public func add(dir: String, body: String, worktreeDir: String, prNumber: UInt32, issueNumber: UInt32)
    throws -> Gozd_V1_Task
  {
    var list = try loadFile(for: dir)
    var task = Gozd_V1_Task()
    task.id = newTaskId()
    task.body = body
    task.worktreeDir = worktreeDir
    task.prNumber = prNumber
    task.issueNumber = issueNumber
    task.createdAt = ISO8601DateFormatter().string(from: Date())
    list.tasks.append(task)
    try saveFile(list, for: dir)
    return task
  }

  public func update(dir: String, id: String, body: String) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.id == id }) else {
      throw TaskStoreError.notFound(id)
    }
    list.tasks[idx].body = body
    try saveFile(list, for: dir)
    return list.tasks[idx]
  }

  public func setWorktreeDir(dir: String, id: String, worktreeDir: String) throws -> Gozd_V1_Task {
    var list = try loadFile(for: dir)
    guard let idx = list.tasks.firstIndex(where: { $0.id == id }) else {
      throw TaskStoreError.notFound(id)
    }
    list.tasks[idx].worktreeDir = worktreeDir
    try saveFile(list, for: dir)
    return list.tasks[idx]
  }

  public func remove(dir: String, id: String) throws {
    var list = try loadFile(for: dir)
    list.tasks.removeAll { $0.id == id }
    try saveFile(list, for: dir)
  }

  // MARK: - paths

  private func projectDir(for dir: String) -> String {
    // worktree 配下のどの dir から呼ばれても同一 projectKey になるよう、
    // git common-dir の親（= main worktree path）を realpath 解決して使う。
    let projectRoot = resolveProjectRoot(for: dir)
    let repoName = (projectRoot as NSString).lastPathComponent
    let digest = SHA256.hash(data: Data(projectRoot.utf8))
    let hash = digest.compactMap { String(format: "%02x", $0) }.joined()
    let shortHash = String(hash.prefix(12))
    let projectKey = "\(repoName)-\(shortHash)"
    return (configDir as NSString)
      .appendingPathComponent("projects")
      .appending("/\(projectKey)")
  }

  /// `git rev-parse --git-common-dir` の出力（典型的には `<main-worktree>/.git`）の親を realpath。
  /// 失敗時は dir 自体を realpath して返す（git 外でも壊れないため）。
  private func resolveProjectRoot(for dir: String) -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git", "rev-parse", "--git-common-dir"]
    process.currentDirectoryURL = URL(fileURLWithPath: dir)
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    do {
      try process.run()
      process.waitUntilExit()
      let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
      _ = stderrPipe.fileHandleForReading.readDataToEndOfFile()
      if process.terminationStatus != 0 {
        return (dir as NSString).resolvingSymlinksInPath
      }
      let text = String(decoding: data, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      // common-dir が相対パスなら dir 起点で resolve する
      let commonDir =
        text.hasPrefix("/")
        ? text
        : (URL(fileURLWithPath: dir).appendingPathComponent(text)).path
      let parent = (commonDir as NSString).deletingLastPathComponent
      return (parent as NSString).resolvingSymlinksInPath
    } catch {
      return (dir as NSString).resolvingSymlinksInPath
    }
  }

  private func tasksFilePath(for dir: String) -> String {
    return (projectDir(for: dir) as NSString).appendingPathComponent("tasks.json")
  }

  private func loadFile(for dir: String) throws -> Gozd_V1_TaskList {
    let path = tasksFilePath(for: dir)
    if !FileManager.default.fileExists(atPath: path) {
      return Gozd_V1_TaskList()
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let json = String(decoding: data, as: UTF8.self)
    return try Gozd_V1_TaskList(jsonString: json)
  }

  private func saveFile(_ list: Gozd_V1_TaskList, for dir: String) throws {
    let path = tasksFilePath(for: dir)
    let dirPath = (path as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(
      atPath: dirPath, withIntermediateDirectories: true)
    let json = try list.jsonString()
    try json.write(toFile: path, atomically: true, encoding: .utf8)
  }

  private func newTaskId() -> String {
    return UUID().uuidString.lowercased()
  }
}

public enum TaskStoreError: Error, Equatable {
  case notFound(String)
}
