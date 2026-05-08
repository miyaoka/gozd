import Foundation
import Testing

@testable import GozdCore

@Suite("GitOps.gitStatus")
struct GitOpsGitStatusTests {
  @Test("空の repo では entries が空")
  func emptyRepo() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    let entries = try await GitOps.gitStatus(dir: dir.path)
    #expect(entries.isEmpty)
  }

  @Test("untracked ファイルは ?? として現れる")
  func untrackedFile() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    try "hello".write(
      to: dir.appendingPathComponent("new.txt"), atomically: true, encoding: .utf8)

    let entries = try await GitOps.gitStatus(dir: dir.path)
    #expect(entries["new.txt"] == "??")
  }

  @Test("コミット済みファイルへの変更は \" M\" として現れる")
  func modifiedFile() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    let file = dir.appendingPathComponent("a.txt")
    try "v1".write(to: file, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "a.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    try "v2".write(to: file, atomically: true, encoding: .utf8)

    let entries = try await GitOps.gitStatus(dir: dir.path)
    #expect(entries["a.txt"] == " M")
  }

  @Test("staged 新規ファイルは \"A \" として現れる")
  func stagedNewFile() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    // 先に initial commit を作って HEAD を確立する（HEAD なしだと A の挙動が異なる）。
    try "seed".write(
      to: dir.appendingPathComponent("seed.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "seed.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)

    try "new".write(
      to: dir.appendingPathComponent("staged.txt"), atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "staged.txt"], cwd: dir.path)

    let entries = try await GitOps.gitStatus(dir: dir.path)
    #expect(entries["staged.txt"] == "A ")
  }

  @Test("renamed ファイルは R で始まり new path を返す（old path は破棄）")
  func renamedFile() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    let oldFile = dir.appendingPathComponent("old.txt")
    try "content".write(to: oldFile, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["add", "old.txt"], cwd: dir.path)
    try await runTestGit(args: ["commit", "-m", "init"], cwd: dir.path)
    try await runTestGit(args: ["mv", "old.txt", "new.txt"], cwd: dir.path)

    let entries = try await GitOps.gitStatus(dir: dir.path)
    #expect(entries["new.txt"]?.first == "R")
    #expect(entries["old.txt"] == nil)
  }

  @Test("git repo でない dir はエラー（exitCode != 0）")
  func notARepo() async throws {
    let tmp = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: tmp) }

    do {
      _ = try await GitOps.gitStatus(dir: tmp.path)
      Issue.record("expected error, got success")
    } catch let GitError.commandFailed(exitCode, stderr) {
      #expect(exitCode != 0)
      #expect(stderr.contains("not a git repository"))
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> URL {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-gitops-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath()
}

private func makeGitRepo() async throws -> URL {
  let dir = try makeTempDir()
  // テスト独立性のため、ここでだけ user.name / user.email を local config に入れる。
  try await runTestGit(args: ["init", "-q", "-b", "main"], cwd: dir.path)
  try await runTestGit(args: ["config", "user.name", "Test"], cwd: dir.path)
  try await runTestGit(args: ["config", "user.email", "test@example.com"], cwd: dir.path)
  return dir
}

/// テスト helper: GitOps と同じ `/usr/bin/env git` 経由で任意の git コマンドを実行する。
private func runTestGit(args: [String], cwd: String) async throws {
  try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git"] + args
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    let nullPipe = Pipe()
    process.standardOutput = nullPipe
    process.standardError = nullPipe
    process.terminationHandler = { proc in
      _ = nullPipe.fileHandleForReading.readDataToEndOfFile()
      if proc.terminationStatus == 0 {
        cont.resume()
      } else {
        cont.resume(
          throwing: GitError.commandFailed(exitCode: proc.terminationStatus, stderr: ""))
      }
    }
    do {
      try process.run()
    } catch {
      cont.resume(throwing: error)
    }
  }
}
