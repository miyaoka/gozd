import Foundation

// git CLI を Foundation `Process` 経由で呼び出すラッパー。
//
// 設計判断:
//
// 1. **戻り値は素の Swift 型**（`[String: String]` 等）。proto 生成型
//    （`Gozd_V1_GitStatusResponse`）への変換は RPC 境界（URLSchemeHandler）で行う。
//    ロジック層を proto に縛らないことでテスト容易性と将来の proto 変更耐性を確保する。
//
// 2. **`/usr/bin/env git`**: ハードコードした `/usr/bin/git` ではなく PATH 解決に
//    任せることで Homebrew 版 git を含む各環境で自然に動かす。
//
// 3. **`Process.terminationHandler` 内で `readDataToEndOfFile()`**: pipe buffer
//    (~64KB) を超えると deadlock するが、`git status` の出力はサイズ有界なので
//    問題ない。大きい出力（git log）が必要になったら DispatchIO に切り替える。
public enum GitOps {
  /// `git status --porcelain=v1 -z` 相当。
  ///
  /// - Parameter dir: worktree の絶対パス。
  /// - Returns: ファイル相対パス → 2 文字の XY ステータスコード（例: " M", "??", "R "）。
  ///   rename エントリは new path → XY のみを返す（old path は破棄）。
  public static func gitStatus(dir: String) async throws -> [String: String] {
    let stdout = try await runGit(args: ["status", "--porcelain=v1", "-z"], cwd: dir)
    return parsePorcelainV1(stdout)
  }
}

public enum GitError: Error, Equatable {
  case commandFailed(exitCode: Int32, stderr: String)
  case launchFailed(String)
}

// MARK: - private helpers

private func runGit(args: [String], cwd: String) async throws -> Data {
  try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git"] + args
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    process.terminationHandler = { proc in
      let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
      let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
      if proc.terminationStatus == 0 {
        cont.resume(returning: stdoutData)
        return
      }
      let stderrText = String(decoding: stderrData, as: UTF8.self)
      cont.resume(
        throwing: GitError.commandFailed(
          exitCode: proc.terminationStatus, stderr: stderrText))
    }

    do {
      try process.run()
    } catch {
      cont.resume(throwing: GitError.launchFailed(error.localizedDescription))
    }
  }
}

/// `git status --porcelain=v1 -z` の出力をパースする。
///
/// 形式:
/// - 通常エントリ: `XY SP path NUL`
/// - rename / copy: `XY SP newpath NUL oldpath NUL`（`X` または `Y` が `R` / `C`）
private func parsePorcelainV1(_ data: Data) -> [String: String] {
  var result: [String: String] = [:]
  var index = data.startIndex

  while index < data.endIndex {
    guard let nul = data[index...].firstIndex(of: 0x00) else { break }
    let entry = data[index..<nul]
    index = data.index(after: nul)

    // 最小サイズ: "XY <SP> <1 char path>" = 4 bytes
    guard entry.count >= 4 else { continue }
    let xyBytes = entry.prefix(2)
    let xy = String(decoding: xyBytes, as: UTF8.self)
    let path = String(decoding: entry.dropFirst(3), as: UTF8.self)
    result[path] = xy

    // rename / copy エントリの場合は old path を 1 つ余分に NUL 区切りで読み飛ばす。
    let firstChar = xyBytes.first
    let secondChar = xyBytes.dropFirst().first
    let isRenameOrCopy =
      firstChar == UInt8(ascii: "R") || firstChar == UInt8(ascii: "C")
      || secondChar == UInt8(ascii: "R") || secondChar == UInt8(ascii: "C")
    if isRenameOrCopy, let oldNul = data[index...].firstIndex(of: 0x00) {
      index = data.index(after: oldNul)
    }
  }

  return result
}
