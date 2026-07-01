import Foundation
import Testing

@testable import GozdCore

@Suite("ClaudeSessionLog")
struct ClaudeSessionLogTests {

  // MARK: - watch_dir 契約

  @Test("空 projects dir では found=false / watchDir = projects 親")
  func read_emptyProjectsDir() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    let result = ClaudeSessionLog.read(
      sessionId: "11111111-2222-3333-4444-555555555555", projectsDir: projects)
    #expect(result.found == false)
    #expect(result.entries.isEmpty)
    #expect(result.watchDir == projects.path)
  }

  @Test("該当 jsonl を含む projectDir が見つかれば found=true / watchDir = その親")
  func read_findsExistingJsonl() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    // fixture: <projects>/-Users-foo-bar/<sid>.jsonl にダミー main を書く
    let sid = "11111111-2222-3333-4444-555555555555"
    let projectDir = projects.appendingPathComponent("-Users-foo-bar", isDirectory: true)
    try fm.createDirectory(at: projectDir, withIntermediateDirectories: true)
    let jsonl = projectDir.appendingPathComponent("\(sid).jsonl", isDirectory: false)
    try Data("{\"type\":\"user\"}\n".utf8).write(to: jsonl)

    // FileManager.contentsOfDirectory は symlink 解決済み (/private/var/...) で URL を返す。
    // 一方 URL.resolvingSymlinksInPath() は macOS の `/var` → `/private/var` 解決を行わない
    // (path components の symlink のみ)。両辺を NSString.resolvingSymlinksInPath 経由で
    // canonical path に正規化して比較する。
    let result = ClaudeSessionLog.read(sessionId: sid, projectsDir: projects)
    #expect(result.found == true)
    #expect(canonical(result.watchDir) == canonical(projectDir.path))
    #expect(result.entries.count == 1)
    #expect(result.entries[0].kind == "main")
    #expect(result.entries[0].id == sid)
    #expect(canonical(result.entries[0].path) == canonical(jsonl.path))
  }

  @Test("無関係な projectDir しか無ければ found=false / watchDir = projects 親")
  func read_jsonlNotFound() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    // 別 sessionId の jsonl だけ存在する fixture
    let otherProjectDir = projects.appendingPathComponent("-Users-foo-other", isDirectory: true)
    try fm.createDirectory(at: otherProjectDir, withIntermediateDirectories: true)
    try Data("{}".utf8).write(
      to: otherProjectDir.appendingPathComponent(
        "99999999-9999-9999-9999-999999999999.jsonl", isDirectory: false))

    let result = ClaudeSessionLog.read(
      sessionId: "11111111-2222-3333-4444-555555555555", projectsDir: projects)
    #expect(result.found == false)
    #expect(result.entries.isEmpty)
    #expect(result.watchDir == projects.path)
  }

  @Test("unsafe sessionId は watchDir = projects 親 / entries 空")
  func read_unsafeSessionId() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    let result = ClaudeSessionLog.read(sessionId: "../etc/passwd", projectsDir: projects)
    #expect(result.found == false)
    #expect(result.entries.isEmpty)
    #expect(result.watchDir == projects.path)
  }

  @Test("projects 親 dir が存在しなければ watchDir 空文字 (renderer 側で error 化)")
  func read_projectsDirMissing() throws {
    let fm = FileManager.default
    let missing = fm.temporaryDirectory
      .appendingPathComponent("gozd-claude-session-log-missing-\(UUID().uuidString.prefix(8))")

    let result = ClaudeSessionLog.read(
      sessionId: "11111111-2222-3333-4444-555555555555", projectsDir: missing)
    #expect(result.found == false)
    #expect(result.entries.isEmpty)
    #expect(result.watchDir == "")
  }

}

// MARK: - Helpers

/// テスト用の projects 親 dir。各テストが defer で cleanup する。
private func makeTempProjectsDir() throws -> URL {
  let url = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-claude-session-log-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return URL(fileURLWithPath: url.path).resolvingSymlinksInPath()
}

/// macOS で `/var` が `/private/var` の symlink である事実を考慮した path 正規化。
/// NSString.resolvingSymlinksInPath は URL の同名メソッドと異なり、各 prefix component
/// の symlink を解決するため `/var/...` を `/private/var/...` に展開する。
private func canonical(_ path: String) -> String {
  return (path as NSString).resolvingSymlinksInPath
}

