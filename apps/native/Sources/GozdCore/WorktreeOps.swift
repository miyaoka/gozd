import Foundation

// worktree / branch を変更する書き込み系操作。
// 読み取り系（list / log）は GitOps、副作用持ち（create / remove / delete）はここ。
public enum WorktreeOps {
  /// `git worktree add [<startPoint>] <absPath> [-B <branch>]` 相当。
  /// `worktreeDir` はリーフ名（typically タイムスタンプ）。1 path component のみ許可（`/`, `..`, `.` は拒否）。
  /// リポジトリ汚染を避けるため `~/.local/share/gozd/worktrees/<projectKey>/<worktreeDir>` に絶対パスとして配置する。
  /// `dir` は main repo / worktree subdir のどれでも可。内部で main repo root に解決して projectKey を統一する。
  /// startPoint があれば -B で新規 or リセットしてブランチ作成、なければ既存ブランチを使う。
  /// startPoint が `origin/<ref>` 形式なら remote-tracking ref をローカルに用意するため
  /// 先行で `git fetch origin <ref>` を実行する。PR picker は GitHub 直問い合わせの head ref を
  /// startPoint に渡すため、ローカル clone が stale な場合に必要。
  public static func createWorktree(
    dir: String, worktreeDir: String, branch: String, startPoint: String?
  ) async throws -> WorktreeInfo {
    let absPath = try ensureWorktreePath(projectDir: dir, leaf: worktreeDir)
    var args = ["worktree", "add"]
    if let startPoint, !startPoint.isEmpty {
      let originPrefix = "origin/"
      if startPoint.hasPrefix(originPrefix) {
        let remoteBranch = String(startPoint.dropFirst(originPrefix.count))
        _ = try await runGit(args: ["fetch", "origin", remoteBranch], cwd: dir)
      }
      // -B: ローカルブランチが既存なら startPoint にリセット、未存在なら作成。
      // 他 worktree で checkout 中のブランチは git 側が `fatal: cannot force update ...` を
      // 返すのでそのまま throw して呼び出し側の notify.error に stderr を流す。
      args.append("-B")
      args.append(branch)
      args.append("--no-track")
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
  /// `projectDir` は main / worktree / その配下 subdir のいずれでも可（内部で main repo root に解決）。
  /// `leaf` は 1 path component のみ許可。`/`, `.`, `..`, NUL バイト、制御文字を含むものは拒否する
  /// （base 配下からの逸脱や、ファイル API への橋渡しでの予期しない扱いを防ぐ）。
  private static func ensureWorktreePath(projectDir: String, leaf: String) throws -> String {
    let invalid =
      leaf.isEmpty
      || leaf.contains("/")
      || leaf == "."
      || leaf == ".."
      || leaf.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
    if invalid {
      throw GitError.commandFailed(
        exitCode: -1, stderr: "invalid worktree leaf name: \(leaf)")
    }
    let projectKey = ProjectKey.resolveAndCompute(for: projectDir)
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
}
