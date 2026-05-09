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

@Suite("GitOps.parseRefs")
struct GitOpsParseRefsTests {
  @Test("空文字は空配列")
  func empty() {
    #expect(GitOps.parseRefs("") == [])
    #expect(GitOps.parseRefs("   ") == [])
  }

  @Test("HEAD -> branch を 2 要素に分解する")
  func splitsHeadArrow() {
    #expect(GitOps.parseRefs("HEAD -> main") == ["HEAD", "main"])
  }

  @Test("tag: prefix は tag: ラベルに正規化する")
  func normalizesTag() {
    #expect(GitOps.parseRefs("tag: v1.0") == ["tag:v1.0"])
  }

  @Test("HEAD / origin / tag が混在するケース")
  func mixed() {
    let input = "HEAD -> 20260510, origin/20260510, tag: v1.0, origin/HEAD"
    #expect(
      GitOps.parseRefs(input) == [
        "HEAD", "20260510", "origin/20260510", "tag:v1.0", "origin/HEAD",
      ])
  }
}

@Suite("GitOps.runGit large output")
struct GitOpsRunGitLargeOutputTests {
  /// pipe buffer (macOS は最大 ~64KB) を超える stdout で `runGit` が deadlock しないことを保証する。
  ///
  /// 旧実装は `Process.terminationHandler` 内で `readDataToEndOfFile()` していたため、
  /// 出力 > buffer の瞬間に子が write block → exit 不能 → terminationHandler が呼ばれない
  /// deadlock になっていた（gozd リポジトリ実体で再現していた症状）。
  @Test("64KB を超える stdout を deadlock せず読み切れる", .timeLimit(.minutes(1)))
  func largeStdoutDoesNotDeadlock() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    // 100KB の本文を持つ commit を作る。`git log --format=%B` で本文を吐かせて
    // 100KB 超の stdout を確実に発生させる。
    let bigBody = String(repeating: "a", count: 100_000)
    let msgFile = dir.appendingPathComponent("msg.txt")
    try bigBody.write(to: msgFile, atomically: true, encoding: .utf8)
    try await runTestGit(args: ["commit", "--allow-empty", "-F", "msg.txt"], cwd: dir.path)
    try? FileManager.default.removeItem(at: msgFile)

    // production 側の drain が正しく動けば自然に返る。修正前は無限 hang していた。
    let result = try await runGit(args: ["log", "--format=%B"], cwd: dir.path)

    #expect(result.count >= 100_000)
    // 大きい出力を別物にすり替えていないことを確認するため、本文の中身まで検証する
    let text = String(decoding: result, as: UTF8.self)
    #expect(text.contains(bigBody))
  }

  /// 同様の deadlock テストを `runGitWithStdin` 側にも適用する。
  /// `git check-ignore --stdin -z` は 64KB 超の path 一覧を flush できる必要がある。
  @Test("runGitWithStdin も 64KB 超の stdin / stdout で deadlock しない", .timeLimit(.minutes(1)))
  func runGitWithStdinLargeIO() async throws {
    let dir = try await makeGitRepo()
    defer { try? FileManager.default.removeItem(at: dir) }

    // .gitignore に 1 行のグロブを書き、check-ignore に多数のパスを流して
    // 大量の ignored path を吐かせる。
    try "*.tmp\n".write(
      to: dir.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)

    // 10000 個の `tmp/N.tmp` を NUL 区切りで作る（≈ 100KB 超）。
    let stdinBytes: Data = {
      var buf = Data()
      for i in 0..<10_000 {
        buf.append(Data("tmp/\(i).tmp\u{0}".utf8))
      }
      return buf
    }()

    let result = try await runGitWithStdin(
      args: ["check-ignore", "--stdin", "-z"], cwd: dir.path, stdin: stdinBytes)

    // ignored entry が NUL 区切りで返る。10000 件すべて返ることまで検証する。
    let nulCount = result.reduce(0) { $0 + ($1 == 0x00 ? 1 : 0) }
    #expect(nulCount == 10_000)
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
/// production 側と同じく `process.environment` を明示 snapshot で渡すことで、
/// 並列 test 実行時の Foundation `Process` 内部の lazy env read による EFAULT を避ける。
///
/// 出力は `/dev/null` に直接捨てる。`Pipe` + `terminationHandler` 内の
/// `readDataToEndOfFile()` パターンは pipe buffer (~64KB) を超える出力で deadlock
/// するため、大きい出力を出すコマンドでも helper 自体が詰まらないように、
/// stdout/stderr を捕捉する必要がない場合は最初から nullDevice に流す。
private func runTestGit(args: [String], cwd: String) async throws {
  try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git"] + args
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    process.environment = ProcessInfo.processInfo.environment
    let null = FileHandle.nullDevice
    process.standardOutput = null
    process.standardError = null
    process.terminationHandler = { proc in
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
