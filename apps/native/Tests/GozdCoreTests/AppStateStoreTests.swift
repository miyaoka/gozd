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

    let store = AppStateStore(configDir: dir)

    var state = Gozd_V1_AppState()
    state.lastOpenedDir = "/Users/test/projects/foo"
    var frame = Gozd_V1_WindowFrame()
    frame.x = 100
    frame.y = 200
    frame.width = 1280
    frame.height = 800
    state.windowFrame = frame

    try store.save(state)
    let loaded = try store.load()

    #expect(loaded.lastOpenedDir == "/Users/test/projects/foo")
    #expect(loaded.windowFrame.x == 100)
    #expect(loaded.windowFrame.y == 200)
    #expect(loaded.windowFrame.width == 1280)
    #expect(loaded.windowFrame.height == 800)
  }

  @Test("ファイル不在時の load は default proto を返す")
  func defaultOnMissing() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let store = AppStateStore(configDir: dir)
    let loaded = try store.load()
    #expect(loaded.lastOpenedDir == "")
    #expect(loaded.windowFrame.width == 0)
  }

  @Test("configDir が存在しなくても save が中間ディレクトリを作る")
  func savesNestedDir() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let nestedDir = (dir as NSString).appendingPathComponent("a/b/c")
    let store = AppStateStore(configDir: nestedDir)

    var state = Gozd_V1_AppState()
    state.lastOpenedDir = "/x"
    try store.save(state)

    let loaded = try store.load()
    #expect(loaded.lastOpenedDir == "/x")
  }

  @Test("save は既存ファイルの未知 top-level field を保持する")
  func preservesUnknownTopLevelFields() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    // 将来バージョンが書いたとみなした JSON を直接配置する
    let filePath = (dir as NSString).appendingPathComponent("app-state.json")
    let initialJson = """
      {
        "lastOpenedDir": "/old",
        "futureField": {"version": 2, "extras": ["a", "b"]}
      }
      """
    try initialJson.write(toFile: filePath, atomically: true, encoding: .utf8)

    let store = AppStateStore(configDir: dir)
    var state = try store.load()
    state.lastOpenedDir = "/new"
    try store.save(state)

    // 保存後のファイルに futureField が残っていることを確認
    let savedData = try Data(contentsOf: URL(fileURLWithPath: filePath))
    guard
      let savedDict = try JSONSerialization.jsonObject(with: savedData) as? [String: Any]
    else {
      Issue.record("saved file is not a JSON object")
      return
    }
    #expect(savedDict["lastOpenedDir"] as? String == "/new")
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

    let store = AppStateStore(configDir: dir)

    // 初回 save: sidebar repos と lastOpenedDir を埋める
    var first = Gozd_V1_AppState()
    first.lastOpenedDir = "/old"
    var repo = Gozd_V1_SidebarRepo()
    repo.rootDir = "/repo/a"
    repo.repoName = "a"
    first.sidebarRepos = [repo]
    try store.save(first)

    // 2 回目 save: 全部空にした状態を渡す
    let cleared = Gozd_V1_AppState()
    try store.save(cleared)

    let loaded = try store.load()
    #expect(loaded.lastOpenedDir == "")
    #expect(loaded.sidebarRepos.isEmpty)
  }

  @Test("load は未知フィールド入り JSON を parse error にしない")
  func loadIgnoresUnknownFields() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let filePath = (dir as NSString).appendingPathComponent("app-state.json")
    let json = """
      {
        "lastOpenedDir": "/x",
        "totallyUnknownField": "should not break parse"
      }
      """
    try json.write(toFile: filePath, atomically: true, encoding: .utf8)

    let store = AppStateStore(configDir: dir)
    let loaded = try store.load()
    #expect(loaded.lastOpenedDir == "/x")
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> String {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-appstate-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath().path
}
