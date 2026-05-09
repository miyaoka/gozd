import Foundation
import os

// git CLI を Foundation `Process` 経由で呼び出すラッパー。
//
// 設計判断:
//
// 1. **戻り値は素の Swift 型**（`[String: String]` 等）。proto 生成型
//    （`Gozd_V1_GitStatusResponse`）への変換は RPC 境界（URLSchemeHandler）で行う。
//    ロジック層を proto に縛らないことでテスト容易性と将来の proto 変更耐性を確保する。
//
// 2. **`CommandResolver` 経由で `git` の絶対パスを解決**: `.app` を Finder/Dock 起動
//    すると launchd 由来の最小 PATH しか継承されないため `/usr/bin/env` の PATH 解決
//    では Homebrew 版 git を選べない。`CommandResolver` がユーザーログインシェル経由で
//    解決した絶対パスを使い、見つからない場合のみ Apple stub `/usr/bin/git` に倒す。
//
// 3. **stdout / stderr は子プロセス生存中に readabilityHandler で drain する**:
//    `terminationHandler` 内で `readDataToEndOfFile()` する設計だと、出力が
//    pipe buffer (macOS は最大 ~64KB) を超えた瞬間に子が write block →
//    exit できず → terminationHandler が呼ばれない deadlock になる。
//    readabilityHandler + DispatchGroup.notify で「stdout EOF / stderr EOF /
//    process termination」が揃った時点で resume する。
public struct WorktreeInfo: Equatable, Sendable {
  public let path: String
  public let head: String
  public let branch: String?
  public let isMain: Bool
  public init(path: String, head: String, branch: String?, isMain: Bool) {
    self.path = path
    self.head = head
    self.branch = branch
    self.isMain = isMain
  }
}

public struct CommitInfo: Equatable, Sendable {
  public let hash: String
  public let shortHash: String
  public let parents: [String]
  public let author: String
  public let date: Int64
  public let message: String
  public let body: String
  public let refs: [String]
  public init(
    hash: String, shortHash: String, parents: [String], author: String, date: Int64,
    message: String, body: String, refs: [String]
  ) {
    self.hash = hash
    self.shortHash = shortHash
    self.parents = parents
    self.author = author
    self.date = date
    self.message = message
    self.body = body
    self.refs = refs
  }
}

public struct FileChangeInfo: Equatable, Sendable {
  public let oldPath: String
  public let newPath: String
  public let type: String  // "A" / "M" / "D" / "R" / "U"
  public init(oldPath: String, newPath: String, type: String) {
    self.oldPath = oldPath
    self.newPath = newPath
    self.type = type
  }
}

public enum GitOps {
  /// `git status --porcelain=v1 -z` 相当。
  public static func gitStatus(dir: String) async throws -> [String: String] {
    let stdout = try await runGit(args: ["status", "--porcelain=v1", "-z"], cwd: dir)
    return parsePorcelainV1(stdout)
  }

  /// `git worktree list --porcelain` 相当。
  public static func worktreeList(dir: String) async throws -> [WorktreeInfo] {
    let stdout = try await runGit(args: ["worktree", "list", "--porcelain"], cwd: dir)
    return parseWorktreePorcelain(stdout)
  }

  /// `git for-each-ref --format='%(refname:short)' refs/heads/` 相当。
  public static func branchList(dir: String) async throws -> [String] {
    let stdout = try await runGit(
      args: ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], cwd: dir)
    let text = String(decoding: stdout, as: UTF8.self)
    return text.split(whereSeparator: { $0 == "\n" }).map(String.init).filter { !$0.isEmpty }
  }

  public struct LogResult: Sendable {
    public let headCommits: [CommitInfo]
    public let defaultBranchCommits: [CommitInfo]
    public let defaultBranch: String
  }

  /// HEAD と default branch（origin/HEAD）の log を返す。
  public static func logBoth(dir: String, maxCount: UInt32, firstParentOnly: Bool) async throws
    -> LogResult
  {
    async let headTask = log(dir: dir, ref: "HEAD", maxCount: maxCount, firstParentOnly: firstParentOnly)
    let defaultBranch = (try? await defaultBranchName(dir: dir)) ?? ""
    let head = try await headTask
    var defaultCommits: [CommitInfo] = []
    if !defaultBranch.isEmpty {
      defaultCommits =
        (try? await log(
          dir: dir, ref: "origin/\(defaultBranch)", maxCount: maxCount,
          firstParentOnly: firstParentOnly)) ?? []
    }
    return LogResult(
      headCommits: head, defaultBranchCommits: defaultCommits, defaultBranch: defaultBranch)
  }

  public struct StatusFull: Equatable, Sendable {
    public let statuses: [String: String]
    public let head: String
    public let hasUpstream: Bool
    public let ahead: UInt32
    public let behind: UInt32
  }

  /// status + HEAD + upstream + ahead/behind を 1 セットで取得する。
  /// `gitStatusChange` push event の payload を構築するために使う。
  ///
  /// `git status --porcelain=v2 --branch -z` の `# branch.oid` / `# branch.upstream`
  /// / `# branch.ab` 行を読む。porcelain v2 の整形が一発で済むので外部呼び出しを
  /// 1 回で済ませられる。
  public static func gitStatusFull(dir: String) async throws -> StatusFull {
    let stdout = try await runGit(
      args: ["status", "--porcelain=v2", "--branch", "-z"], cwd: dir)
    return parsePorcelainV2WithBranch(stdout)
  }

  /// 与えられた相対パス群のうち gitignore で無視されているものを Set で返す。
  /// - dir 配下が git 管理されていない / git が無い場合は空 Set を返す（throw しない）。
  /// - 入力空なら git を起動せず即時空 Set を返す。
  ///
  /// `git check-ignore --stdin -z` を使い、stdin に NUL 区切りでパスを流す。
  /// 出力も NUL 区切りで「無視されたパス」だけが返る。1 fork で全件まとめて判定できる。
  public static func checkIgnore(dir: String, relPaths: [String]) async -> Set<String> {
    if relPaths.isEmpty { return [] }
    let stdinBytes = relPaths
      .map { $0.data(using: .utf8) ?? Data() }
      .reduce(Data()) { acc, next in acc + next + Data([0x00]) }
    do {
      let stdout = try await runGitWithStdin(
        args: ["check-ignore", "--stdin", "-z"], cwd: dir, stdin: stdinBytes)
      return parseNulSeparatedPaths(stdout)
    } catch {
      // not a git repo / no .gitignore 等は exit code != 0。無視されたパス無しとして扱う。
      return []
    }
  }

  /// `git rev-parse --show-toplevel` 相当。git repo の最上位ディレクトリを返す。
  /// dir が git 管理下でない場合は throw（commandFailed）する。
  public static func repoTopLevel(dir: String) async throws -> String {
    let stdout = try await runGit(args: ["rev-parse", "--show-toplevel"], cwd: dir)
    return String(decoding: stdout, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
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

  /// `git symbolic-ref --short refs/remotes/origin/HEAD` 相当。`origin/main` 等を返す。
  /// origin/ の prefix は剥がして `main` のみ返す。
  public static func defaultBranchName(dir: String) async throws -> String {
    let stdout = try await runGit(
      args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd: dir)
    let text = String(decoding: stdout, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
    if text.hasPrefix("origin/") { return String(text.dropFirst("origin/".count)) }
    return text
  }

  /// `git log <ref>` を unit-separator 区切りでパースしてコミット一覧を返す。
  public static func log(
    dir: String, ref: String = "HEAD", maxCount: UInt32, firstParentOnly: Bool
  ) async throws -> [CommitInfo] {
    // %x1f = unit separator (US), %x1e = record separator (RS)
    let format = "%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s%x1f%b%x1f%D%x1e"
    var args = ["log", "--format=\(format)"]
    if maxCount > 0 { args.append("--max-count=\(maxCount)") }
    if firstParentOnly { args.append("--first-parent") }
    args.append(ref)
    let stdout = try await runGit(args: args, cwd: dir)
    let text = String(decoding: stdout, as: UTF8.self)
    var commits: [CommitInfo] = []
    for record in text.split(separator: "\u{1e}", omittingEmptySubsequences: true) {
      let trimmed = record.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      let parts = trimmed.split(separator: "\u{1f}", omittingEmptySubsequences: false).map(
        String.init)
      // 8 fields: hash, shortHash, parents, author, date, subject, body, refs
      guard parts.count == 8 else { continue }
      let parents =
        parts[2].isEmpty
        ? [] : parts[2].split(separator: " ", omittingEmptySubsequences: true).map(String.init)
      let date = Int64(parts[4]) ?? 0
      let refs =
        parts[7].isEmpty
        ? []
        : parts[7].split(separator: ",").map {
          $0.trimmingCharacters(in: .whitespaces)
        }
      commits.append(
        CommitInfo(
          hash: parts[0], shortHash: parts[1], parents: parents, author: parts[3], date: date,
          message: parts[5], body: parts[6], refs: refs))
    }
    return commits
  }

  /// `git diff -- <path>` 相当（作業ツリー差分）。
  public static func diffFile(dir: String, relPath: String) async throws -> String {
    let stdout = try await runGit(args: ["diff", "--", relPath], cwd: dir)
    return String(decoding: stdout, as: UTF8.self)
  }

  /// `git show HEAD:<path>` 相当。
  public static func showFile(dir: String, relPath: String) async throws -> Data {
    return try await runGit(args: ["show", "HEAD:\(relPath)"], cwd: dir)
  }

  /// `git show <hash>:<path>` 相当。
  public static func showCommitFile(dir: String, hash: String, relPath: String) async throws
    -> Data
  {
    return try await runGit(args: ["show", "\(hash):\(relPath)"], cwd: dir)
  }

  /// `git diff-tree -r --name-status -z <hash>` または 2 コミット間。
  public static func commitFiles(dir: String, hash: String, compareHash: String?) async throws
    -> [FileChangeInfo]
  {
    var args = ["diff-tree", "-r", "--name-status", "-z"]
    if let compareHash, !compareHash.isEmpty {
      args.append(compareHash)
      args.append(hash)
    } else {
      args.append(hash)
    }
    let stdout = try await runGit(args: args, cwd: dir)
    return parseDiffTreeNameStatus(stdout)
  }
}

public enum GitError: Error, Equatable {
  case commandFailed(exitCode: Int32, stderr: String)
  case launchFailed(String)
}

// MARK: - private helpers

/// `git check-ignore --stdin -z` の NUL 区切り出力をパスの Set に変換する。
private func parseNulSeparatedPaths(_ data: Data) -> Set<String> {
  var result: Set<String> = []
  var start = data.startIndex
  while start < data.endIndex {
    guard let nul = data[start...].firstIndex(of: 0x00) else { break }
    let segment = data[start..<nul]
    if !segment.isEmpty {
      result.insert(String(decoding: segment, as: UTF8.self))
    }
    start = data.index(after: nul)
  }
  return result
}

// `runProcessCollectingOutput` は `ProcessExec.swift` に共通化した。

/// `git` の絶対パスを resolve する。1 次解決失敗時のみ Apple stub `/usr/bin/git` に倒す。
private func resolveGitPath() async -> String {
  if let path = await CommandResolver.shared.resolve("git") {
    return path
  }
  return "/usr/bin/git"
}

/// stdin にデータを渡して git を起動する。`runGit` と同じ戻り値契約。
/// `launchFailed` を検知した場合、CommandResolver のキャッシュが stale な可能性が
/// あるため 1 回だけ invalidate + 再 resolve して retry する。
func runGitWithStdin(args: [String], cwd: String, stdin: Data) async throws -> Data {
  do {
    return try await runGitWithStdinOnce(
      gitPath: await resolveGitPath(), args: args, cwd: cwd, stdin: stdin)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("git")
    return try await runGitWithStdinOnce(
      gitPath: await resolveGitPath(), args: args, cwd: cwd, stdin: stdin)
  }
}

private func runGitWithStdinOnce(gitPath: String, args: [String], cwd: String, stdin: Data)
  async throws -> Data
{
  let process = Process()
  process.executableURL = URL(fileURLWithPath: gitPath)
  process.arguments = args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  // 明示的に env snapshot を渡す。Foundation Process は environment が nil のとき
  // 内部で `ProcessInfo.processInfo.environment` を遅延読みするが、その経路は
  // `getenv`/`environ` の thread-unsafety が並列 spawn 時に EFAULT (Code=14) を
  // 引く要因になり得る。spawn 前に snapshot を取って渡せば内部 lazy read を回避できる。
  process.environment = ProcessInfo.processInfo.environment

  let stdinPipe = Pipe()
  let stdoutPipe = Pipe()
  let stderrPipe = Pipe()
  process.standardInput = stdinPipe
  process.standardOutput = stdoutPipe
  process.standardError = stderrPipe

  let (stdoutData, stderrData) = try await runProcessCollectingOutput(
    process: process,
    stdoutPipe: stdoutPipe,
    stderrPipe: stderrPipe,
    afterRun: {
      // stdin を書き込んで EOF を送る。書き込み中の例外は git 終了で拾うので try? で握る。
      try? stdinPipe.fileHandleForWriting.write(contentsOf: stdin)
      try? stdinPipe.fileHandleForWriting.close()
    }
  )

  // git check-ignore は無視パスがあれば exit 0、無ければ exit 1。1 を「結果なし」
  // として扱うため、stderr が空なら成功扱いで stdout を返す。
  // exit code != 0 かつ stderr に出力があれば従来どおりエラー化する。
  if process.terminationStatus == 0 || stderrData.isEmpty {
    return stdoutData
  }
  throw GitError.commandFailed(
    exitCode: process.terminationStatus,
    stderr: String(decoding: stderrData, as: UTF8.self))
}

func runGit(args: [String], cwd: String) async throws -> Data {
  do {
    return try await runGitOnce(gitPath: await resolveGitPath(), args: args, cwd: cwd)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("git")
    return try await runGitOnce(gitPath: await resolveGitPath(), args: args, cwd: cwd)
  }
}

private func runGitOnce(gitPath: String, args: [String], cwd: String) async throws -> Data {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: gitPath)
  process.arguments = args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  process.environment = ProcessInfo.processInfo.environment

  let stdoutPipe = Pipe()
  let stderrPipe = Pipe()
  process.standardOutput = stdoutPipe
  process.standardError = stderrPipe

  let (stdoutData, stderrData) = try await runProcessCollectingOutput(
    process: process,
    stdoutPipe: stdoutPipe,
    stderrPipe: stderrPipe
  )

  if process.terminationStatus == 0 {
    return stdoutData
  }
  throw GitError.commandFailed(
    exitCode: process.terminationStatus,
    stderr: String(decoding: stderrData, as: UTF8.self))
}

/// `git worktree list --porcelain` の出力をパースする。
private func parseWorktreePorcelain(_ data: Data) -> [WorktreeInfo] {
  let text = String(decoding: data, as: UTF8.self)
  var result: [WorktreeInfo] = []
  var path: String?
  var head: String = ""
  var branch: String?
  var isDetached = false

  func flush() {
    guard let p = path, !p.isEmpty else { return }
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
    }
  }
  flush()
  return result
}

/// `git diff-tree --name-status -z` の出力をパースする。
/// 通常エントリ: `<status>\0<path>\0`、rename: `R<score>\0<old>\0<new>\0`
private func parseDiffTreeNameStatus(_ data: Data) -> [FileChangeInfo] {
  let text = String(decoding: data, as: UTF8.self)
  let parts = text.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)
  var result: [FileChangeInfo] = []
  var i = 0
  while i < parts.count {
    let status = parts[i]
    if status.isEmpty {
      i += 1
      continue
    }
    let firstChar = String(status.prefix(1))
    if firstChar == "R" || firstChar == "C" {
      guard i + 2 < parts.count else { break }
      let oldPath = parts[i + 1]
      let newPath = parts[i + 2]
      result.append(FileChangeInfo(oldPath: oldPath, newPath: newPath, type: firstChar))
      i += 3
    } else {
      guard i + 1 < parts.count else { break }
      let path = parts[i + 1]
      result.append(FileChangeInfo(oldPath: path, newPath: path, type: firstChar))
      i += 2
    }
  }
  return result
}

/// `git status --porcelain=v1 -z` の出力をパースする。
///
/// 形式:
/// - 通常エントリ: `XY SP path NUL`
/// - rename / copy: `XY SP newpath NUL oldpath NUL`（`X` または `Y` が `R` / `C`）
/// `git status --porcelain=v2 --branch -z` の出力を parse して StatusFull を返す。
///
/// 出力形式（NUL 区切り）:
/// - `# branch.oid <sha>` — HEAD ハッシュ。`(initial)` ならまだコミットがない
/// - `# branch.head <name>` — branch 名
/// - `# branch.upstream <name>` — upstream（あれば）
/// - `# branch.ab +<ahead> -<behind>` — ahead/behind（upstream あれば）
/// - 続いて各ファイルエントリ（`1 XY ...` / `2 XY ...` / `u ...` / `? path`）
///
/// 各エントリは XY を抽出して path にマップする。porcelain v1 と XY の形式は同じ。
/// `2`（rename）は古い path を後続の NUL 区切りで読み飛ばす。
private func parsePorcelainV2WithBranch(_ data: Data) -> GitOps.StatusFull {
  var statuses: [String: String] = [:]
  var head = ""
  var hasUpstream = false
  var ahead: UInt32 = 0
  var behind: UInt32 = 0

  var index = data.startIndex
  while index < data.endIndex {
    guard let nul = data[index...].firstIndex(of: 0x00) else { break }
    let entry = data[index..<nul]
    index = data.index(after: nul)
    if entry.isEmpty { continue }

    let line = String(decoding: entry, as: UTF8.self)
    if line.hasPrefix("# branch.oid ") {
      let oid = String(line.dropFirst("# branch.oid ".count))
      head = oid == "(initial)" ? "" : oid
    } else if line.hasPrefix("# branch.upstream ") {
      hasUpstream = true
    } else if line.hasPrefix("# branch.ab ") {
      // 形式: "+<ahead> -<behind>"
      let rest = line.dropFirst("# branch.ab ".count)
      let parts = rest.split(separator: " ")
      for part in parts {
        if part.hasPrefix("+") {
          ahead = UInt32(part.dropFirst()) ?? 0
        } else if part.hasPrefix("-") {
          behind = UInt32(part.dropFirst()) ?? 0
        }
      }
    } else if line.hasPrefix("# ") {
      // branch.head 等は無視
      continue
    } else if line.hasPrefix("1 ") {
      // "1 XY <sub> <mH> <mI> <mW> <hH> <hI> <path>"
      let fields = line.split(
        separator: " ", maxSplits: 8, omittingEmptySubsequences: false)
      if fields.count >= 9 {
        let xy = String(fields[1])
        let path = String(fields[8])
        statuses[path] = xy
      }
    } else if line.hasPrefix("2 ") {
      // rename/copy: "2 XY <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>"
      // 続いて NUL 区切りで <orig_path>。
      let fields = line.split(
        separator: " ", maxSplits: 9, omittingEmptySubsequences: false)
      if fields.count >= 10 {
        let xy = String(fields[1])
        let path = String(fields[9])
        statuses[path] = xy
      }
      // orig_path を読み飛ばす
      if let origNul = data[index...].firstIndex(of: 0x00) {
        index = data.index(after: origNul)
      }
    } else if line.hasPrefix("u ") {
      // unmerged: "u XY <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      let fields = line.split(
        separator: " ", maxSplits: 10, omittingEmptySubsequences: false)
      if fields.count >= 11 {
        let xy = String(fields[1])
        let path = String(fields[10])
        statuses[path] = xy
      }
    } else if line.hasPrefix("? ") {
      // untracked
      let path = String(line.dropFirst(2))
      statuses[path] = "??"
    } else if line.hasPrefix("! ") {
      // ignored — 通常 --porcelain では出ないが、無視
      continue
    }
  }

  return GitOps.StatusFull(
    statuses: statuses, head: head, hasUpstream: hasUpstream, ahead: ahead, behind: behind)
}

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
