import Foundation
import Testing

@testable import GozdCore

@Suite("FSOps.readFile")
struct FSOpsReadFileTests {
  @Test("dir 配下の text ファイルを読める")
  func readsText() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let target = (dir as NSString).appendingPathComponent("a.txt")
    try "hello".write(toFile: target, atomically: true, encoding: .utf8)

    let info = try FSOps.readFile(dir: dir, path: "a.txt")
    #expect(info.content == "hello")
    #expect(info.isBinary == false)
    #expect(info.notFound == false)
  }

  @Test("バイナリファイルは is_binary=true で返される")
  func readsBinary() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let bytes = Data((0..<256).map { UInt8($0) })
    let target = (dir as NSString).appendingPathComponent("bin")
    try bytes.write(to: URL(fileURLWithPath: target))

    let info = try FSOps.readFile(dir: dir, path: "bin")
    #expect(info.isBinary == true)
    #expect(info.content == "")
  }

  @Test("dir 範囲外への path traversal は FSError.outsideDir で拒否される")
  func rejectsTraversal() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    do {
      _ = try FSOps.readFile(dir: dir, path: "../../etc/passwd")
      Issue.record("expected FSError.outsideDir")
    } catch FSError.outsideDir {
      // ok
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

@Suite("FSOps.readDir")
struct FSOpsReadDirTests {
  @Test("ファイル / ディレクトリ / symlink を type 付きで返す")
  func listsEntries() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let fileURL = URL(fileURLWithPath: (dir as NSString).appendingPathComponent("a.txt"))
    let subDirURL = URL(fileURLWithPath: (dir as NSString).appendingPathComponent("sub"))
    let symlinkURL = URL(fileURLWithPath: (dir as NSString).appendingPathComponent("link"))

    try "x".write(to: fileURL, atomically: true, encoding: .utf8)
    try FileManager.default.createDirectory(at: subDirURL, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: symlinkURL, withDestinationURL: fileURL)

    let entries = try await FSOps.readDir(dir: dir, path: ".").entries
    #expect(entries.count == 3)
    #expect(entries.contains(FSEntry(name: "a.txt", type: "file")))
    #expect(entries.contains(FSEntry(name: "sub", type: "directory")))
    #expect(entries.contains(FSEntry(name: "link", type: "symlink")))
  }

  @Test("空ディレクトリは空配列")
  func emptyDir() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let entries = try await FSOps.readDir(dir: dir, path: ".").entries
    #expect(entries.isEmpty)
  }

  @Test("存在しないディレクトリは throw せず notFound を返す")
  func notFoundForMissingDir() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    // dir 配下の存在しないサブディレクトリ（削除済みノード相当）を読む
    let result = try await FSOps.readDir(dir: dir, path: "gone")
    #expect(result.notFound == true)
    #expect(result.entries.isEmpty)
  }

  @Test("ディレクトリが同名ファイルに置換された場合も notFound を返す")
  func notFoundForDirReplacedByFile() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    // 展開中ディレクトリが削除後に同名ファイルへ置き換わったケース（ENOTDIR）
    let replaced = (dir as NSString).appendingPathComponent("sub")
    try "x".write(to: URL(fileURLWithPath: replaced), atomically: true, encoding: .utf8)

    let result = try await FSOps.readDir(dir: dir, path: "sub")
    #expect(result.notFound == true)
    #expect(result.entries.isEmpty)
  }

  @Test("読み取り権限の無いディレクトリは notFound ではなく throw する")
  func throwsForUnreadableDir() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let locked = (dir as NSString).appendingPathComponent("locked")
    try FileManager.default.createDirectory(
      at: URL(fileURLWithPath: locked), withIntermediateDirectories: true)
    // 読み取り不可にする。defer で戻して removeItem が成功するようにする。
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: locked)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: locked) }

    do {
      _ = try await FSOps.readDir(dir: dir, path: "locked")
      Issue.record("expected readDir to throw for unreadable directory")
    } catch {
      // permission denied は真の読み取りエラーとして throw されるのが期待挙動
    }
  }

  @Test("dir 範囲外は拒否される")
  func rejectsTraversal() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    do {
      _ = try await FSOps.readDir(dir: dir, path: "../..")
      Issue.record("expected FSError.outsideDir")
    } catch FSError.outsideDir {
      // ok
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }

  @Test(".git directory は除外、近傍名 (.git*, .gita 等) は残る (完全一致境界)")
  func excludesDotGitDirectoryOnly() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    // 除外対象
    try FileManager.default.createDirectory(
      at: URL(fileURLWithPath: (dir as NSString).appendingPathComponent(".git")),
      withIntermediateDirectories: true)
    // .git* prefix で誤巻き込みされないか、部分一致で誤検出されないかの境界 fixture
    for name in [".gitignore", ".gitkeep", ".gitattributes", ".gita", "git", "agit"] {
      let p = (dir as NSString).appendingPathComponent(name)
      try "x".write(to: URL(fileURLWithPath: p), atomically: true, encoding: .utf8)
    }

    let entries = try await FSOps.readDir(dir: dir, path: ".").entries
    let names = Set(entries.map { $0.name })
    #expect(!names.contains(".git"))
    for name in [".gitignore", ".gitkeep", ".gitattributes", ".gita", "git", "agit"] {
      #expect(names.contains(name), "expected entry \(name) to remain")
    }
  }

  @Test(".git file (worktree gitlink) は除外、近傍名は残る (完全一致境界)")
  func excludesDotGitFileOnly() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let gitFile = (dir as NSString).appendingPathComponent(".git")
    try "gitdir: /tmp/somewhere/.git/worktrees/foo\n".write(
      to: URL(fileURLWithPath: gitFile), atomically: true, encoding: .utf8)
    for name in [".gitignore", ".gitkeep", ".gita"] {
      let p = (dir as NSString).appendingPathComponent(name)
      try "x".write(to: URL(fileURLWithPath: p), atomically: true, encoding: .utf8)
    }

    let entries = try await FSOps.readDir(dir: dir, path: ".").entries
    let names = Set(entries.map { $0.name })
    #expect(!names.contains(".git"))
    for name in [".gitignore", ".gitkeep", ".gita"] {
      #expect(names.contains(name), "expected entry \(name) to remain")
    }
  }

  @Test("git repo 内では .gitignore に一致する entry の isIgnored=true")
  func gitIgnoreReflectedInReadDir() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    // tmp dir を git init して .gitignore で `node_modules` を ignore する
    try await runGitForTest(args: ["init", "-q"], cwd: dir)
    let gitignore = (dir as NSString).appendingPathComponent(".gitignore")
    try "node_modules\n".write(
      to: URL(fileURLWithPath: gitignore), atomically: true, encoding: .utf8)
    try FileManager.default.createDirectory(
      at: URL(fileURLWithPath: (dir as NSString).appendingPathComponent("node_modules")),
      withIntermediateDirectories: true)
    let kept = (dir as NSString).appendingPathComponent("kept.txt")
    try "x".write(to: URL(fileURLWithPath: kept), atomically: true, encoding: .utf8)

    let entries = try await FSOps.readDir(dir: dir, path: ".").entries
    let nm = entries.first { $0.name == "node_modules" }
    let keptEntry = entries.first { $0.name == "kept.txt" }
    #expect(nm?.isIgnored == true)
    #expect(keptEntry?.isIgnored == false)
  }
}

private func runGitForTest(args: [String], cwd: String) async throws {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  process.arguments = ["git"] + args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  process.environment = ProcessInfo.processInfo.environment
  // stdout / stderr を捨てる。Pipe を作って読まないと OS の PIPE buffer 枯渇で deadlock するため
  // nullDevice を割り当てる。
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  try process.run()
  process.waitUntilExit()
  if process.terminationStatus != 0 {
    throw GitTestHelperError.nonZeroExit(
      args: args, status: process.terminationStatus)
  }
}

private enum GitTestHelperError: Error, CustomStringConvertible {
  case nonZeroExit(args: [String], status: Int32)
  var description: String {
    switch self {
    case .nonZeroExit(let args, let status):
      return "git \(args.joined(separator: " ")) failed with exit code \(status)"
    }
  }
}

// MARK: - Helpers

private func makeTempDir() throws -> String {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-fsops-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath().path
}
