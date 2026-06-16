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

  // MARK: - subagent 累積スナップショットの dedupe (issue #792)

  @Test("同一 spawn root の累積スナップショット群が 1 トラックに畳まれ最新が残る")
  func read_dedupesCumulativeSnapshots() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    let sid = "11111111-2222-3333-4444-555555555555"
    let subagents = try makeSubagentsDir(projects: projects, sessionId: sid)

    // 同一 spawn root (uuid AAA) を共有する累積コピー 3 個。行数が単調増加し、最長が superset。
    let root = "aaaaaaaa-0000-0000-0000-000000000000"
    try writeSubagent(subagents, agentId: "a01", lines: jsonl(firstUuid: root, count: 2))
    try writeSubagent(subagents, agentId: "a02", lines: jsonl(firstUuid: root, count: 4))
    let longest = jsonl(firstUuid: root, count: 6)
    try writeSubagent(subagents, agentId: "a03", lines: longest)

    let result = ClaudeSessionLog.read(sessionId: sid, projectsDir: projects)
    let subs = result.entries.filter { $0.kind == "subagent" }
    #expect(subs.count == 1)
    #expect(subs[0].id == "a03")  // 最長 = superset
    #expect(subs[0].content == longest)
  }

  @Test("別 spawn root の subagent は別トラックのまま残る")
  func read_keepsDistinctRootsSeparate() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    let sid = "11111111-2222-3333-4444-555555555555"
    let subagents = try makeSubagentsDir(projects: projects, sessionId: sid)

    let rootA = "aaaaaaaa-0000-0000-0000-000000000000"
    let rootB = "bbbbbbbb-0000-0000-0000-000000000000"
    try writeSubagent(subagents, agentId: "a01", lines: jsonl(firstUuid: rootA, count: 2))
    try writeSubagent(subagents, agentId: "a02", lines: jsonl(firstUuid: rootA, count: 4))
    try writeSubagent(subagents, agentId: "b01", lines: jsonl(firstUuid: rootB, count: 3))

    let result = ClaudeSessionLog.read(sessionId: sid, projectsDir: projects)
    let subs = result.entries.filter { $0.kind == "subagent" }
    #expect(subs.count == 2)
    #expect(Set(subs.map { $0.id }) == ["a02", "b01"])
  }

  @Test("先頭 uuid 欠落ファイルは agentId フォールバックで各々独立 entry として残る")
  func read_keepsUuidlessFilesIndependent() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    let sid = "11111111-2222-3333-4444-555555555555"
    let subagents = try makeSubagentsDir(projects: projects, sessionId: sid)

    // 先頭行に uuid を持たない (旧フォーマット / 取得失敗) 2 ファイル。grouping できないので
    // それぞれ独立 entry として残る (agentId フォールバックで衝突させない)。
    try writeSubagent(subagents, agentId: "c01", lines: "{\"type\":\"user\"}\n")
    try writeSubagent(subagents, agentId: "c02", lines: "{\"type\":\"user\"}\n")

    let result = ClaudeSessionLog.read(sessionId: sid, projectsDir: projects)
    let subs = result.entries.filter { $0.kind == "subagent" }
    #expect(subs.count == 2)
    #expect(Set(subs.map { $0.id }) == ["c01", "c02"])
  }

  @Test("通常 Task subagent (各々別 uuid の単一ファイル) は dedupe で畳まれない")
  func read_doesNotFoldNormalTaskSubagents() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    let sid = "11111111-2222-3333-4444-555555555555"
    let subagents = try makeSubagentsDir(projects: projects, sessionId: sid)

    try writeSubagent(
      subagents, agentId: "t01", lines: jsonl(firstUuid: "11110000-0000-0000-0000-000000000000", count: 5))
    try writeSubagent(
      subagents, agentId: "t02", lines: jsonl(firstUuid: "22220000-0000-0000-0000-000000000000", count: 5))

    let result = ClaudeSessionLog.read(sessionId: sid, projectsDir: projects)
    let subs = result.entries.filter { $0.kind == "subagent" }
    #expect(subs.count == 2)
    #expect(Set(subs.map { $0.id }) == ["t01", "t02"])
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

/// fixture: <projects>/-Users-foo-bar/<sid>.jsonl (main) +
/// <projects>/-Users-foo-bar/<sid>/subagents/ を作り subagents dir を返す。
private func makeSubagentsDir(projects: URL, sessionId: String) throws -> URL {
  let fm = FileManager.default
  let projectDir = projects.appendingPathComponent("-Users-foo-bar", isDirectory: true)
  try fm.createDirectory(at: projectDir, withIntermediateDirectories: true)
  let main = projectDir.appendingPathComponent("\(sessionId).jsonl", isDirectory: false)
  try Data("{\"type\":\"user\"}\n".utf8).write(to: main)
  let subagents = projectDir
    .appendingPathComponent(sessionId, isDirectory: true)
    .appendingPathComponent("subagents", isDirectory: true)
  try fm.createDirectory(at: subagents, withIntermediateDirectories: true)
  return subagents
}

/// subagents/agent-<agentId>.jsonl を書く。
private func writeSubagent(_ subagents: URL, agentId: String, lines: String) throws {
  let file = subagents.appendingPathComponent("agent-\(agentId).jsonl", isDirectory: false)
  try Data(lines.utf8).write(to: file)
}

/// 先頭行の uuid を `firstUuid` 固定、後続は連番 uuid の JSONL を `count` 行生成する。
/// 累積コピーは先頭 (spawn root) が同一なので、これで「同一 root の長短違いスナップショット」
/// を再現できる。
private func jsonl(firstUuid: String, count: Int) -> String {
  return (0..<count)
    .map { i in
      let uuid = i == 0 ? firstUuid : "ffffffff-0000-0000-0000-\(String(format: "%012d", i))"
      return "{\"uuid\":\"\(uuid)\",\"type\":\"user\"}"
    }
    .joined(separator: "\n") + "\n"
}
