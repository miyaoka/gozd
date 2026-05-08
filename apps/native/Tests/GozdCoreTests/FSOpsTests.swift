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

    let data = try FSOps.readFile(dir: dir, path: "a.txt")
    #expect(String(decoding: data, as: UTF8.self) == "hello")
  }

  @Test("バイナリファイルもバイト等価で読める")
  func readsBinary() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let bytes = Data((0..<256).map { UInt8($0) })
    let target = (dir as NSString).appendingPathComponent("bin")
    try bytes.write(to: URL(fileURLWithPath: target))

    let data = try FSOps.readFile(dir: dir, path: "bin")
    #expect(data == bytes)
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
  func listsEntries() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let fileURL = URL(fileURLWithPath: (dir as NSString).appendingPathComponent("a.txt"))
    let subDirURL = URL(fileURLWithPath: (dir as NSString).appendingPathComponent("sub"))
    let symlinkURL = URL(fileURLWithPath: (dir as NSString).appendingPathComponent("link"))

    try "x".write(to: fileURL, atomically: true, encoding: .utf8)
    try FileManager.default.createDirectory(at: subDirURL, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: symlinkURL, withDestinationURL: fileURL)

    let entries = try FSOps.readDir(dir: dir, path: ".")
    #expect(entries.count == 3)
    #expect(entries.contains(FSEntry(name: "a.txt", type: "file")))
    #expect(entries.contains(FSEntry(name: "sub", type: "directory")))
    #expect(entries.contains(FSEntry(name: "link", type: "symlink")))
  }

  @Test("空ディレクトリは空配列")
  func emptyDir() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    let entries = try FSOps.readDir(dir: dir, path: ".")
    #expect(entries.isEmpty)
  }

  @Test("dir 範囲外は拒否される")
  func rejectsTraversal() throws {
    let dir = try makeTempDir()
    defer { try? FileManager.default.removeItem(at: URL(fileURLWithPath: dir)) }

    do {
      _ = try FSOps.readDir(dir: dir, path: "../..")
      Issue.record("expected FSError.outsideDir")
    } catch FSError.outsideDir {
      // ok
    } catch {
      Issue.record("unexpected error: \(error)")
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
