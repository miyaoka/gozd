import Foundation
import Testing

@testable import GozdCore

@Suite("ClaudeSessionLog")
struct ClaudeSessionLogTests {

  // MARK: - encodedProjectDir (純関数)

  @Test("空文字 worktreePath は nil")
  func encodedProjectDir_empty() {
    let projects = URL(fileURLWithPath: "/Users/x/.claude/projects", isDirectory: true)
    #expect(ClaudeSessionLog.encodedProjectDir(worktreePath: "", projectsDir: projects) == nil)
  }

  @Test("absolute でないパスは nil")
  func encodedProjectDir_relative() {
    let projects = URL(fileURLWithPath: "/Users/x/.claude/projects", isDirectory: true)
    #expect(
      ClaudeSessionLog.encodedProjectDir(
        worktreePath: "Users/foo/bar", projectsDir: projects) == nil)
  }

  @Test("単純な absolute パスは `/` → `-`")
  func encodedProjectDir_basic() {
    let projects = URL(fileURLWithPath: "/Users/x/.claude/projects", isDirectory: true)
    let result = ClaudeSessionLog.encodedProjectDir(
      worktreePath: "/Users/foo/bar", projectsDir: projects)
    #expect(result == "/Users/x/.claude/projects/-Users-foo-bar")
  }

  @Test("`.` も `-` に置換 (連続区切りは `--`)")
  func encodedProjectDir_dotReplacement() {
    let projects = URL(fileURLWithPath: "/Users/x/.claude/projects", isDirectory: true)
    let result = ClaudeSessionLog.encodedProjectDir(
      worktreePath: "/Users/foo/.local/bar", projectsDir: projects)
    #expect(result == "/Users/x/.claude/projects/-Users-foo--local-bar")
  }

  @Test("実機 fixture と一致する gozd worktree path encoding")
  func encodedProjectDir_realisticFixture() {
    let projects = URL(fileURLWithPath: "/Users/miyaoka/.claude/projects", isDirectory: true)
    let result = ClaudeSessionLog.encodedProjectDir(
      worktreePath: "/Users/miyaoka/.local/share/gozd/worktrees/dotfiles-8db986b0bb06-20260608_040258",
      projectsDir: projects)
    #expect(
      result
        == "/Users/miyaoka/.claude/projects/-Users-miyaoka--local-share-gozd-worktrees-dotfiles-8db986b0bb06-20260608_040258"
    )
  }

  // MARK: - resolveSpecificWatchDir (副作用境界 3 分岐)

  @Test("expected dir が既存ならそのパスを返す (mkdir しない)")
  func resolveSpecificWatchDir_existing() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    let worktree = "/Users/foo/existing"
    let expected = projects.appendingPathComponent("-Users-foo-existing", isDirectory: true)
    try fm.createDirectory(at: expected, withIntermediateDirectories: true)

    let result = ClaudeSessionLog.resolveSpecificWatchDir(
      worktreePath: worktree, projectsDir: projects, fm: fm)
    #expect(result == expected.path)
    #expect(fm.fileExists(atPath: expected.path))
  }

  @Test("expected dir が不在なら mkdir で作って返す")
  func resolveSpecificWatchDir_createsWhenMissing() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    let worktree = "/Users/foo/new"
    let expected = projects.appendingPathComponent("-Users-foo-new", isDirectory: true)
    #expect(!fm.fileExists(atPath: expected.path))

    let result = ClaudeSessionLog.resolveSpecificWatchDir(
      worktreePath: worktree, projectsDir: projects, fm: fm)
    #expect(result == expected.path)
    var isDir: ObjCBool = false
    #expect(fm.fileExists(atPath: expected.path, isDirectory: &isDir))
    #expect(isDir.boolValue)
  }

  @Test("worktreePath 空なら空文字を返す (mkdir もしない)")
  func resolveSpecificWatchDir_emptyWorktree() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    let result = ClaudeSessionLog.resolveSpecificWatchDir(
      worktreePath: "", projectsDir: projects, fm: fm)
    #expect(result == "")
  }

  @Test("expected path にファイルが居ると mkdir 失敗で空文字")
  func resolveSpecificWatchDir_mkdirFails() throws {
    let fm = FileManager.default
    let projects = try makeTempProjectsDir()
    defer { try? fm.removeItem(at: projects) }

    let worktree = "/Users/foo/collision"
    let collidingPath = projects.appendingPathComponent(
      "-Users-foo-collision", isDirectory: false)
    // dir 名で予約された path に file を置いて createDirectory を失敗させる
    try Data("blocker".utf8).write(to: collidingPath)

    let result = ClaudeSessionLog.resolveSpecificWatchDir(
      worktreePath: worktree, projectsDir: projects, fm: fm)
    #expect(result == "")
  }

  // MARK: - read (worktreePath SSOT の結合)

  @Test("worktreePath 空は found=false / watchDir 空 / entries 空")
  func read_emptyWorktreePath() {
    let result = ClaudeSessionLog.read(
      sessionId: "11111111-2222-3333-4444-555555555555", worktreePath: "")
    #expect(result.found == false)
    #expect(result.entries.isEmpty)
    #expect(result.watchDir == "")
  }

  @Test("unsafe sessionId は watchDir 算出後に found=false で返る")
  func read_unsafeSessionId() throws {
    // 副作用 (mkdir) が ~/.claude/projects/ 配下に走らないよう、絶対作られない
    // 親 dir を指す worktreePath で resolveSpecificWatchDir を組み立てさせる…のは
    // 不可能なので、homeDirectoryForCurrentUser 固定の本経路では検証せず、
    // 「unsafe sessionId は found=false / entries 空」だけを assert する。
    let result = ClaudeSessionLog.read(
      sessionId: "../etc/passwd", worktreePath: "/Users/test/safe-worktree")
    #expect(result.found == false)
    #expect(result.entries.isEmpty)
    // 副作用 cleanup: read の resolveSpecificWatchDir で実 home 配下に mkdir された
    // 可能性がある。空 dir を取り除く (idempotent)。
    let projects = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".claude", isDirectory: true)
      .appendingPathComponent("projects", isDirectory: true)
    let created = projects.appendingPathComponent(
      "-Users-test-safe-worktree", isDirectory: true)
    try? FileManager.default.removeItem(at: created)
  }
}

// MARK: - Helpers

/// テスト用の projects 親 dir。各テスト終了時に呼び出し側が cleanup する。
private func makeTempProjectsDir() throws -> URL {
  let url = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-claude-session-log-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return URL(fileURLWithPath: url.path).resolvingSymlinksInPath()
}
