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

    let entries = try await FSOps.readDir(dir: dir, path: ".")
    #expect(entries.count == 3)
    #expect(entries.contains(FSEntry(name: "a.txt", type: "file")))
    #expect(entries.contains(FSEntry(name: "sub", type: "directory")))
    #expect(entries.contains(FSEntry(name: "link", type: "symlink")))
  }

  @Test("空ディレクトリは空配列")
  func emptyDir() async throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let entries = try await FSOps.readDir(dir: dir, path: ".")
    #expect(entries.isEmpty)
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

    let entries = try await FSOps.readDir(dir: dir, path: ".")
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
  process.standardOutput = Pipe()
  process.standardError = Pipe()
  try process.run()
  process.waitUntilExit()
}

// MARK: - Helpers

private func makeTempDir() throws -> String {
  let raw = FileManager.default.temporaryDirectory
    .appendingPathComponent("gozd-fsops-\(UUID().uuidString.prefix(8))")
  try FileManager.default.createDirectory(at: raw, withIntermediateDirectories: true)
  return URL(fileURLWithPath: raw.path).resolvingSymlinksInPath().path
}
