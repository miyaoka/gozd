import Foundation

// worktree / branch を変更する書き込み系操作。
// 読み取り系（list / log）は GitOps、副作用持ち（create / remove / delete）はここ。
public enum WorktreeOps {
  /// `git worktree add [<startPoint>] <absPath> [-b <branch>]` 相当。
  /// `worktreeDir` はリーフ名（典型的にはタイムスタンプ）。リポジトリ汚染を避けるため
  /// `~/.local/share/gozd/worktrees/<projectKey>/<worktreeDir>` に絶対パスとして配置する。
  /// startPoint があれば -b で新規ブランチを作る。なければ既存ブランチを使う。
  public static func createWorktree(
    dir: String, worktreeDir: String, branch: String, startPoint: String?
  ) async throws -> WorktreeInfo {
    let absPath = try ensureWorktreePath(projectDir: dir, leaf: worktreeDir)
    var args = ["worktree", "add"]
    if let startPoint, !startPoint.isEmpty {
      args.append("-b")
      args.append(branch)
      args.append(absPath)
      args.append(startPoint)
    } else {
      args.append(absPath)
      args.append(branch)
    }
    _ = try await runGit(args: args, cwd: dir)
    let list = try await GitOps.worktreeList(dir: dir)
    let resolved = (absPath as NSString).resolvingSymlinksInPath
    guard
      let entry = list.first(where: {
        $0.path == absPath || ($0.path as NSString).resolvingSymlinksInPath == resolved
      })
    else {
      throw GitError.commandFailed(
        exitCode: -1, stderr: "worktree created but not found in list: \(absPath)")
    }
    return entry
  }

  /// `~/.local/share/gozd/worktrees/<projectKey>/<leaf>` の絶対パスを返し、親ディレクトリを作成する。
  private static func ensureWorktreePath(projectDir: String, leaf: String) throws -> String {
    let projectKey = ProjectKey.compute(forMainRepoRoot: projectDir)
    let home = NSHomeDirectory()
    let base = (home as NSString)
      .appendingPathComponent(".local/share/gozd/worktrees")
      .appending("/\(projectKey)")
    try FileManager.default.createDirectory(
      atPath: base, withIntermediateDirectories: true)
    return (base as NSString).appendingPathComponent(leaf)
  }

  /// `git worktree remove [-f] <path>` 相当。
  public static func removeWorktree(dir: String, path: String, force: Bool) async throws {
    var args = ["worktree", "remove"]
    if force { args.append("-f") }
    args.append(path)
    _ = try await runGit(args: args, cwd: dir)
  }

  /// `git branch -D <branch>` 相当（force delete）。
  public static func deleteBranch(dir: String, branch: String) async throws {
    _ = try await runGit(args: ["branch", "-D", branch], cwd: dir)
  }
}
