import Foundation

// worktree / git dir 解決系の RPC op。`git worktree list --porcelain` と
// `git rev-parse --path-format=absolute --git-dir / --git-common-dir` をラップする。

extension GitOps {
  public struct GitDirs: Equatable, Sendable {
    /// `git rev-parse --git-dir` の絶対パス。
    /// 通常 clone では `<repo>/.git`、worktree では `<parent>/.git/worktrees/<name>` を指す。
    public let perWorktreeGitDir: String
    /// `git rev-parse --git-common-dir` の絶対パス。
    /// 通常 clone では `perWorktreeGitDir` と一致。worktree では親 `<parent>/.git` を指す。
    public let commonGitDir: String
  }

  /// `git worktree list --porcelain` 相当。
  public static func worktreeList(dir: String) async throws -> [WorktreeInfo] {
    let stdout = try await runGit(args: ["worktree", "list", "--porcelain"], cwd: dir)
    return parseWorktreePorcelain(stdout)
  }

  /// `git rev-parse --show-toplevel` 相当。git repo の最上位ディレクトリを返す。
  /// dir が git 管理下でない場合は throw（commandFailed）する。
  public static func repoTopLevel(dir: String) async throws -> String {
    let stdout = try await runGit(args: ["rev-parse", "--show-toplevel"], cwd: dir)
    return String(decoding: stdout, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
  }

  /// per-worktree git dir と common git dir の絶対パスを 1 回の `git rev-parse` で取る。
  /// FSEvents の path 比較に使うため呼び出し側で realpath 解決すること。
  ///
  /// - dir が git 管理下でない場合は **nil** を返す（git rev-parse は exit 128）。
  ///   これは「git repo ではない」という事実を nil で表す正常パスで、エラーではない。
  /// - git バイナリ不在 / 出力形式破綻 / その他 I/O 失敗は throw する。
  ///   呼び出し側で `try?` で握り潰すと「worktree なのに git dir が解決できない」障害が
  ///   サイレントに通常 watch にフォールバックされ、commit 反映バグが復活する。
  public static func gitDirs(dir: String) async throws -> GitDirs? {
    // `git rev-parse` は `-z` / `--null` 等の NUL 区切り出力モードを持たず、複数フラグを
    // 同時指定すると newline 区切りで返す。改行を含むパス（`<repo\nname>/.git` 等の
    // 病的ケース）で fragile になるため、フラグを 1 つずつ別 spawn して各呼び出しが
    // 単一行のみ返す形にする。spawn コストは worktree オープン時のみで実用上問題ない。
    let perWorktree: String
    let common: String
    do {
      perWorktree = try await singleRevParse(flag: "--git-dir", cwd: dir)
      common = try await singleRevParse(flag: "--git-common-dir", cwd: dir)
    } catch let GitError.commandFailed(exitCode, _) where exitCode == 128 {
      // exit 128 = "not a git repository"。git の規約。
      return nil
    }
    return GitDirs(perWorktreeGitDir: perWorktree, commonGitDir: common)
  }

  /// `git rev-parse --path-format=absolute <flag>` を 1 回 spawn し、単一行の trim 済み path を返す。
  /// 出力が空ならば不正として throw。
  private static func singleRevParse(flag: String, cwd: String) async throws -> String {
    let stdout = try await runGit(
      args: ["rev-parse", "--path-format=absolute", flag], cwd: cwd)
    let text = String(decoding: stdout, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      throw GitError.unexpectedOutput("git rev-parse \(flag): empty output")
    }
    return text
  }

  /// 全 worktree が共有する main repo の作業ディレクトリを返す。
  /// 非 bare repo では `git rev-parse --git-common-dir` の親ディレクトリ。
  /// gozd の `~/.local/share/gozd/worktrees/<repo>-<hash>/<timestamp>` のような worktree から
  /// 元の repo（例: `~/g/g/miyaoka/gozd`）を逆引きするのに使う。
  /// 失敗時は throw（commandFailed）する。
  public static func mainRepoRoot(dir: String) async throws -> String {
    let stdout = try await runGit(
      args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd: dir)
    let commonDir = String(decoding: stdout, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
    if commonDir.isEmpty { return "" }
    return (commonDir as NSString).deletingLastPathComponent
  }
}

// MARK: - parser

/// `git worktree list --porcelain` の出力をパースする。
///
/// `prunable` 注釈付きのエントリは git にとっても解決不能な孤児（gitdir file が
/// 指す先が消滅している等）なので listing から除外する。`git status` 等の後段操作は
/// 必ず失敗するため、SSOT 段階で落とす。
private func parseWorktreePorcelain(_ data: Data) -> [WorktreeInfo] {
  let text = String(decoding: data, as: UTF8.self)
  var result: [WorktreeInfo] = []
  var path: String?
  var head: String = ""
  var branch: String?
  var isDetached = false
  var isPrunable = false

  func flush() {
    guard let p = path, !p.isEmpty else { return }
    if isPrunable { return }
    let isMain = result.isEmpty  // 最初のエントリが main worktree
    let resolvedBranch = isDetached ? nil : branch
    result.append(WorktreeInfo(path: p, head: head, branch: resolvedBranch, isMain: isMain))
  }

  for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
    let s = String(line)
    if s.isEmpty {
      flush()
      path = nil
      head = ""
      branch = nil
      isDetached = false
      isPrunable = false
      continue
    }
    if s.hasPrefix("worktree ") {
      path = String(s.dropFirst("worktree ".count))
    } else if s.hasPrefix("HEAD ") {
      head = String(s.dropFirst("HEAD ".count))
    } else if s.hasPrefix("branch ") {
      let ref = String(s.dropFirst("branch ".count))
      branch =
        ref.hasPrefix("refs/heads/") ? String(ref.dropFirst("refs/heads/".count)) : ref
    } else if s == "detached" {
      isDetached = true
    } else if s == "prunable" || s.hasPrefix("prunable ") {
      isPrunable = true
    }
  }
  flush()
  return result
}
