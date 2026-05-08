import Foundation

// worktree / branch を変更する書き込み系操作。
// 読み取り系（list / log）は GitOps、副作用持ち（create / remove / delete）はここ。
public enum WorktreeOps {
  /// `git worktree add [<startPoint>] <worktreeDir> [-b <branch>]` 相当。
  /// startPoint があれば -b で新規ブランチを作る。なければ既存ブランチを使う。
  public static func createWorktree(
    dir: String, worktreeDir: String, branch: String, startPoint: String?
  ) async throws -> WorktreeInfo {
    var args = ["worktree", "add"]
    if let startPoint, !startPoint.isEmpty {
      args.append("-b")
      args.append(branch)
      args.append(worktreeDir)
      args.append(startPoint)
    } else {
      args.append(worktreeDir)
      args.append(branch)
    }
    _ = try await runGit(args: args, cwd: dir)
    let list = try await GitOps.worktreeList(dir: dir)
    guard let entry = list.first(where: { $0.path == worktreeDir }) else {
      throw GitError.commandFailed(
        exitCode: -1, stderr: "worktree created but not found in list: \(worktreeDir)")
    }
    return entry
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
