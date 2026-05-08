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
}

// MARK: - Helpers

private func makeTempDir() throws -> String {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-appstate-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath().path
}
