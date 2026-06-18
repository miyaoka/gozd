import Foundation
import GozdProto
import Testing

@testable import GozdCore

@Suite("AppStateStore")
struct AppStateStoreTests {
  @Test("save → load で proto フィールドが round-trip する")
  func roundTrip() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let store = AppStateStore(stateDir: dir)

    var state = Gozd_V1_AppState()
    var repo = Gozd_V1_SidebarRepo()
    repo.rootDir = "/Users/test/projects/foo"
    repo.repoName = "foo"
    repo.isGitRepo = true
    repo.collapsed = true
    var wt = Gozd_V1_WorktreeCacheEntry()
    wt.path = "/Users/test/projects/foo/wt1"
    wt.branch = "feature/x"
    wt.isMain = false
    repo.worktrees = [wt]
    state.sidebarRepos = [repo]

    try store.save(state)
    let loaded = try store.load()

    #expect(loaded.sidebarRepos.count == 1)
    let r = loaded.sidebarRepos[0]
    #expect(r.rootDir == "/Users/test/projects/foo")
    #expect(r.repoName == "foo")
    #expect(r.isGitRepo == true)
    #expect(r.collapsed == true)
    #expect(r.worktrees.count == 1)
    #expect(r.worktrees[0].path == "/Users/test/projects/foo/wt1")
    #expect(r.worktrees[0].branch == "feature/x")
    #expect(r.worktrees[0].isMain == false)
  }

  @Test("ファイル不在時の load は default proto を返す")
  func defaultOnMissing() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let store = AppStateStore(stateDir: dir)
    let loaded = try store.load()
    #expect(loaded.sidebarRepos.isEmpty)
  }

  @Test("stateDir が存在しなくても save が中間ディレクトリを作る")
  func savesNestedDir() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let nestedDir = (dir as NSString).appendingPathComponent("a/b/c")
    let store = AppStateStore(stateDir: nestedDir)

    var state = Gozd_V1_AppState()
    var repo = Gozd_V1_SidebarRepo()
    repo.rootDir = "/x"
    state.sidebarRepos = [repo]
    try store.save(state)

    let loaded = try store.load()
    #expect(loaded.sidebarRepos.first?.rootDir == "/x")
  }

  @Test("save は既存ファイルの未知 top-level field を保持する")
  func preservesUnknownTopLevelFields() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    // 将来バージョンが書いたとみなした JSON を直接配置する
    let filePath = (dir as NSString).appendingPathComponent("app-state.json")
    let initialJson = """
      {
        "sidebarRepos": [{"rootDir": "/old"}],
        "futureField": {"version": 2, "extras": ["a", "b"]}
      }
      """
    try initialJson.write(toFile: filePath, atomically: true, encoding: .utf8)

    let store = AppStateStore(stateDir: dir)
    var state = try store.load()
    var repo = Gozd_V1_SidebarRepo()
    repo.rootDir = "/new"
    state.sidebarRepos = [repo]
    try store.save(state)

    // 保存後のファイルに futureField が残っていることを確認
    let savedData = try Data(contentsOf: URL(fileURLWithPath: filePath))
    guard
      let savedDict = try JSONSerialization.jsonObject(with: savedData) as? [String: Any]
    else {
      Issue.record("saved file is not a JSON object")
      return
    }
    let savedRepos = savedDict["sidebarRepos"] as? [[String: Any]]
    #expect(savedRepos?.first?["rootDir"] as? String == "/new")
    #expect(savedDict["futureField"] != nil)
    if let future = savedDict["futureField"] as? [String: Any] {
      #expect(future["version"] as? Int == 2)
      #expect((future["extras"] as? [String]) == ["a", "b"])
    } else {
      Issue.record("futureField was not preserved as a dictionary")
    }
  }

  @Test("save は known field の空化を保存する（古い値が復活しない）")
  func clearsKnownFields() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let store = AppStateStore(stateDir: dir)

    // 初回 save: sidebar repos を埋める
    var first = Gozd_V1_AppState()
    var repo = Gozd_V1_SidebarRepo()
    repo.rootDir = "/repo/a"
    repo.repoName = "a"
    first.sidebarRepos = [repo]
    try store.save(first)

    // 2 回目 save: 全部空にした状態を渡す
    let cleared = Gozd_V1_AppState()
    try store.save(cleared)

    let loaded = try store.load()
    #expect(loaded.sidebarRepos.isEmpty)
  }

  @Test("load は未知フィールド入り JSON を parse error にしない")
  func loadIgnoresUnknownFields() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let filePath = (dir as NSString).appendingPathComponent("app-state.json")
    let json = """
      {
        "sidebarRepos": [{"rootDir": "/x"}],
        "totallyUnknownField": "should not break parse"
      }
      """
    try json.write(toFile: filePath, atomically: true, encoding: .utf8)

    let store = AppStateStore(stateDir: dir)
    let loaded = try store.load()
    #expect(loaded.sidebarRepos.first?.rootDir == "/x")
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> String {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-appstate-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath().path
}
