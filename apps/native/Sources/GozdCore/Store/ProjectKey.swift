import CryptoKit
import Foundation

// プロジェクト固有の永続化先を決める projectKey の生成。
//
// projectKey は `<repoName>-<sha256(realpath)[0..12]>`。
// 同じ main repo の worktree 配下からどの dir で呼んでも、main repo root に解決した上で
// 同一 projectKey が出るようにする。
//
// 利用箇所:
// - `~/.config/gozd/projects/<projectKey>/config.json`（ProjectConfigStore）
// - `~/.config/gozd/projects/<projectKey>/tasks.json`（TaskStore）
// - `~/.local/share/gozd/worktrees/<projectKey>/<leaf>`（WorktreeOps）
//
// 形式変更は全 store の保存先を変えるため、変更時は移行コードを別途用意する必要がある。
public enum ProjectKey {
  /// すでに main repo root と分かっている dir から projectKey を生成する。
  /// 内部で realpath（symlink 解決）してからハッシュする。
  public static func compute(forMainRepoRoot dir: String) -> String {
    let resolved = (dir as NSString).resolvingSymlinksInPath
    let repoName = (resolved as NSString).lastPathComponent
    let digest = SHA256.hash(data: Data(resolved.utf8))
    let hash = digest.compactMap { String(format: "%02x", $0) }.joined()
    return "\(repoName)-\(String(hash.prefix(12)))"
  }

  /// 任意の dir（worktree 配下を含む）から main repo root を引いて projectKey を生成する。
  /// `git rev-parse --git-common-dir` の親が main worktree のパス。git 外 / 失敗時は dir 自体を使う。
  public static func resolveAndCompute(for dir: String) -> String {
    return compute(forMainRepoRoot: resolveMainRepoRoot(for: dir))
  }

  /// `git rev-parse --git-common-dir` の出力（典型的には `<main-worktree>/.git`）の親を realpath。
  /// 失敗時は dir 自体を realpath して返す（git 外でも壊れないため）。
  public static func resolveMainRepoRoot(for dir: String) -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git", "rev-parse", "--git-common-dir"]
    process.currentDirectoryURL = URL(fileURLWithPath: dir)
    process.environment = ProcessInfo.processInfo.environment
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    do {
      try process.run()
      process.waitUntilExit()
      let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
      _ = stderrPipe.fileHandleForReading.readDataToEndOfFile()
      if process.terminationStatus != 0 {
        return (dir as NSString).resolvingSymlinksInPath
      }
      let text = String(decoding: data, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      // common-dir が相対パスなら dir 起点で resolve する
      let commonDir =
        text.hasPrefix("/")
        ? text
        : (URL(fileURLWithPath: dir).appendingPathComponent(text)).path
      let parent = (commonDir as NSString).deletingLastPathComponent
      return (parent as NSString).resolvingSymlinksInPath
    } catch {
      return (dir as NSString).resolvingSymlinksInPath
    }
  }
}
