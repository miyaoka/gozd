import CryptoKit
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
//    では Homebrew / mise 版 git を選べない。`CommandResolver` がユーザーログインシェル
//    経由で `command -v git` を実行し、ターミナルで叩く git と同一バイナリを返す。
//    解決に失敗した場合は `launchFailed` を throw して呼び出し側 (notify.error) に
//    通知する。Apple stub `/usr/bin/git` への暗黙 fallback は行わない: ターミナルで
//    Homebrew git を使っているユーザーに対して `.app` だけ CLT git に倒すと、Keychain
//    ACL が binary path 単位のため credential が引き継がれず、認証プロンプトが
//    再発する。CLT only ユーザーはログインシェル経由でも `/usr/bin/git` が返るため
//    fallback 無しでも救われる。
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
  /// `git status --porcelain=v1 -z --untracked-files=all` 相当。
  /// `--untracked-files=all` は untracked ディレクトリ配下のファイルも個別に列挙させる
  /// ため必須（外すと git が `dir/` のように親ディレクトリ 1 エントリに畳む）。
  public static func gitStatus(dir: String) async throws -> [String: String] {
    let stdout = try await runGit(
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd: dir)
    return parsePorcelainV1(stdout)
  }

  /// `git worktree list --porcelain` 相当。
  public static func worktreeList(dir: String) async throws -> [WorktreeInfo] {
    let stdout = try await runGit(args: ["worktree", "list", "--porcelain"], cwd: dir)
    return parseWorktreePorcelain(stdout)
  }

  public struct LogResult: Sendable {
    public let headCommits: [CommitInfo]
    public let defaultBranchCommits: [CommitInfo]
    public let defaultBranch: String
  }

  /// HEAD と default branch（origin/HEAD）の log を返す。
  ///
  /// エラー方針:
  /// - `commandFailed`（origin 未設定 / unborn branch 等のドメイン失敗）は空文字列 / 空配列に倒す
  /// - `launchFailed`（shell spawn 失敗 / hang）は rethrow して上位の `notify.error` まで通す
  /// - `commandNotFound`（git CLI 未インストール）も rethrow（`catch` していないので自動的に
  ///   propagate する。renderer 側で「インストールしてください」UI を出す前提）
  ///
  /// `try?` で 3 種を区別せず潰すと、git-graph が「空」「gozd が git を解決できていない」
  /// 「ユーザーが git をインストールしていない」を見分けられなくなる。
  public static func logBoth(dir: String, maxCount: UInt32, firstParentOnly: Bool) async throws
    -> LogResult
  {
    async let headTask = log(
      dir: dir, ref: "HEAD", maxCount: maxCount, firstParentOnly: firstParentOnly)
    let defaultBranch: String
    do {
      defaultBranch = try await defaultBranchName(dir: dir)
    } catch GitError.commandFailed {
      defaultBranch = ""
    }
    let head = try await headTask
    var defaultCommits: [CommitInfo] = []
    if !defaultBranch.isEmpty {
      do {
        defaultCommits = try await log(
          dir: dir, ref: "origin/\(defaultBranch)", maxCount: maxCount,
          firstParentOnly: firstParentOnly)
      } catch GitError.commandFailed {
        defaultCommits = []
      }
    }
    return LogResult(
      headCommits: head, defaultBranchCommits: defaultCommits, defaultBranch: defaultBranch)
  }

  public struct StatusFull: Equatable, Sendable {
    public let statuses: [String: String]
    public let head: String
    /// `git status --porcelain=v2 --branch` の `# branch.head` の値。HEAD が指す
    /// ブランチ名（例: `main`）。detached HEAD の場合は空文字。
    /// `git branch -m` は OID を変えないため、rename の検知はこの値の変化で行う。
    public let branchHead: String
    public let hasUpstream: Bool
    public let ahead: UInt32
    public let behind: UInt32
  }

  /// status + HEAD + upstream + ahead/behind を 1 セットで取得する。
  /// `gitStatusChange` push event の payload を構築するために使う。
  ///
  /// `git status --porcelain=v2 --branch -z --untracked-files=all` の `# branch.oid` /
  /// `# branch.upstream` / `# branch.ab` 行を読む。porcelain v2 の整形が一発で済むので
  /// 外部呼び出しを 1 回で済ませられる。
  /// `--untracked-files=all` は untracked ディレクトリ配下のファイルも個別に列挙させる
  /// ため必須（外すと git が `dir/` のように親ディレクトリ 1 エントリに畳む）。
  public static func gitStatusFull(dir: String) async throws -> StatusFull {
    let stdout = try await runGit(
      args: ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], cwd: dir)
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

  public struct GitDirs: Equatable, Sendable {
    /// `git rev-parse --git-dir` の絶対パス。
    /// 通常 clone では `<repo>/.git`、worktree では `<parent>/.git/worktrees/<name>` を指す。
    public let perWorktreeGitDir: String
    /// `git rev-parse --git-common-dir` の絶対パス。
    /// 通常 clone では `perWorktreeGitDir` と一致。worktree では親 `<parent>/.git` を指す。
    public let commonGitDir: String
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

  /// `git for-each-ref refs/heads/ refs/remotes/` の出力の SHA-256 hex digest。
  /// renderer 側で前回値と比較し、不一致なら push event の取りこぼしを検知する観察可能性
  /// の補強として使う（低頻度 pull 整合性チェック）。「予防 retry」ではなく、SSOT 経路
  /// の到達率を計測する用途。digest は安定ソートされた出力を読むため、git の内部ソート
  /// に依存する。
  public static func refsDigest(dir: String) async throws -> String {
    let stdout = try await runGit(
      args: [
        "for-each-ref", "refs/heads/", "refs/remotes/",
        "--format=%(refname) %(objectname)",
      ], cwd: dir)
    let hash = SHA256.hash(data: stdout)
    return hash.map { String(format: "%02x", $0) }.joined()
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
    // `--decorate=short` でユーザーの `log.decorate=full` 設定を上書きする。
    // full にすると %D が `refs/heads/main` / `refs/remotes/origin/main` 形式になり、
    // renderer の `r.startsWith("origin/")` / current branch 抽出が崩れる。
    var args = ["log", "--format=\(format)", "--decorate=short"]
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
      let refs = parseRefs(parts[7])
      commits.append(
        CommitInfo(
          hash: parts[0], shortHash: parts[1], parents: parents, author: parts[3], date: date,
          message: parts[5], body: parts[6], refs: refs))
    }
    return commits
  }

  /// `git log --format=%D` の出力をパースする。
  /// "HEAD -> main, origin/main, tag: v1.0" → ["HEAD", "main", "origin/main", "tag:v1.0"]
  /// "HEAD -> branch" は ["HEAD", "branch"] に分解する。renderer 側が
  /// refs.includes("HEAD") で HEAD 行を識別するため、HEAD は独立要素である必要がある。
  ///
  /// 区切り子は `, `（カンマ+スペース）固定（git の log-tree.c::format_decoration_default）。
  /// ref 名にはカンマを含めることが許されている（`git check-ref-format --branch 'foo,bar'` が
  /// 通る）ため、単純な `,` 分割は ref 名を破壊する。スペースは ref 名に含められないので
  /// `", "` 区切りなら一意にトークン化できる。
  static func parseRefs(_ refStr: String) -> [String] {
    let trimmed = refStr.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return [] }
    var result: [String] = []
    for raw in trimmed.components(separatedBy: ", ") {
      let part = raw.trimmingCharacters(in: .whitespaces)
      if part.isEmpty { continue }
      if part.hasPrefix("HEAD -> ") {
        result.append("HEAD")
        result.append(String(part.dropFirst("HEAD -> ".count)))
      } else if part.hasPrefix("tag: ") {
        result.append("tag:" + String(part.dropFirst("tag: ".count)))
      } else {
        result.append(part)
      }
    }
    return result
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

  /// 指定コミット（または範囲指定）の name-status 差分を返す。
  ///
  /// - 単一コミット非ルート: `git diff <hash>^ <hash>` で first parent との比較。
  ///   merge commit でも `hash^` が first parent に解決されるため GitHub の表示と一致する
  ///   差分になる。`diff-tree -m --first-parent` は先祖の変更が混入するので使わない。
  /// - 単一ルートコミット: `git diff-tree --root --no-commit-id -r` を使う（親が無いので
  ///   `^` で解決できない）。
  /// - 範囲指定（rangeHashes 非空）: renderer が git-graph の表示順で組み立てた commit hash 列の
  ///   先頭（newer）と末尾（older）を 2 endpoint として `git diff <older>^ <newer>` を 1 回実行する。
  ///   commit ごとの first-parent diff を union するアプローチは rename chain（foo→bar→baz）や
  ///   rename 後 delete を解決できず、logical file identity が壊れるため避ける。
  ///   2 点 diff にすれば git の rename detection が一発で chain を畳む。中間 commit で revert
  ///   された変更が消える点はトレードオフだが、UI 直感（最終状態の差分）と一致する。
  ///   older が root commit なら empty tree を起点にする。
  ///   includeWorkingTree が true の場合（範囲の片端が Working Tree）は第 2 引数を省略して
  ///   working tree との比較に切り替える。
  ///
  /// 共通 diff オプション: `--name-status -z --find-renames --diff-filter=AMDR`。
  public static func commitFiles(
    dir: String, hash: String, compareHash: String?, rangeHashes: [String] = [],
    includeWorkingTree: Bool = false
  ) async throws -> [FileChangeInfo] {
    let diffOptions = ["--name-status", "-z", "--find-renames", "--diff-filter=AMDR"]

    if let newer = rangeHashes.first, let older = rangeHashes.last {
      let isOlderRoot = try await isRootCommit(dir: dir, hash: older)
      let from = isOlderRoot ? emptyTreeHash : "\(older)^"
      let diffArgs: [String] =
        includeWorkingTree
        ? ["diff"] + diffOptions + [from]
        : ["diff"] + diffOptions + [from, newer]
      let stdout = try await runGit(args: diffArgs, cwd: dir)
      return parseDiffNameStatus(stdout)
    }

    if try await isRootCommit(dir: dir, hash: hash) {
      let stdout = try await runGit(
        args: ["diff-tree", "--root", "--no-commit-id", "-r"] + diffOptions + [hash], cwd: dir)
      return parseDiffNameStatus(stdout)
    }
    let stdout = try await runGit(
      args: ["diff"] + diffOptions + ["\(hash)^", hash], cwd: dir)
    return parseDiffNameStatus(stdout)
  }
}

/// git の well-known empty tree object hash。`git hash-object -t tree </dev/null` で
/// 得られる固定値。root commit を range の起点にする際、`<root>` 自身ではなく empty tree
/// を `from` に置くことで root commit が追加したファイルも diff に含まれる。
private let emptyTreeHash = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

public enum GitError: Error, Equatable {
  case commandFailed(exitCode: Int32, stderr: String)
  case launchFailed(String)
  /// `command -v <name>` が空を返した = コマンドが未インストール。
  /// `launchFailed` (spawn/hang/起動エラー) と区別するため別 case。
  /// retry layer は `commandNotFound` を retry しない（invalidate しても再 spawn しても結果は同じ）。
  case commandNotFound(name: String)
  /// git は exit 0 で正常終了したが stdout のフォーマットが想定外。
  /// `commandFailed` は `exitCode != 0` を含意するため流用せず別 case にする。
  case unexpectedOutput(String)
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

/// `git` の絶対パスを resolve する。
///
/// - shell spawn 失敗 / hang / 起動エラー → `GitError.launchFailed` を throw（retry 対象）
/// - `command -v` が空 = git CLI 未インストール → `GitError.commandNotFound` を throw（retry 不要、即上位へ）
///
/// Apple stub `/usr/bin/git` への暗黙 fallback は行わない（モジュール先頭コメント参照）。
private func resolveGitPath() async throws -> String {
  guard let path = try await CommandResolver.shared.resolve("git") else {
    throw GitError.commandNotFound(name: "git")
  }
  return path
}

/// stdin にデータを渡して git を起動する。`runGit` と同じ戻り値契約。
/// `launchFailed` を検知した場合、CommandResolver のキャッシュが stale な可能性が
/// あるため 1 回だけ invalidate + 再 resolve して retry する。
func runGitWithStdin(args: [String], cwd: String, stdin: Data) async throws -> Data {
  do {
    return try await runGitWithStdinOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd, stdin: stdin)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("git")
    return try await runGitWithStdinOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd, stdin: stdin)
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
  process.environment = gozdGitEnv()

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

/// gozd 用 git 環境変数を組み立てる。`ProcessInfo.processInfo.environment` を snapshot し、
/// `GIT_OPTIONAL_LOCKS=0` を上書き設定する。
///
/// `GIT_OPTIONAL_LOCKS=0` は read-only な git コマンド (`status` 等) が index stat refresh
/// 用に行う **opportunistic な `index.lock` 取得を抑止**する。gozd は FSEvents 駆動で
/// バックグラウンドに `git status` 等を頻繁に叩くため、この設定が無いとユーザーが foreground
/// で叩いた `git commit` / `git add` と lock 競合し、ユーザー側が exit 128
/// (`Unable to create '.../index.lock': File exists`) で即死する。
/// git 自身がこのシナリオ（バックグラウンドツール並走）のために提供している env で、
/// VS Code / GitHub Desktop 等の主要 GUI クライアントも同じ設定を入れている。
private func gozdGitEnv() -> [String: String] {
  var env = ProcessInfo.processInfo.environment
  env["GIT_OPTIONAL_LOCKS"] = "0"
  return env
}

func runGit(args: [String], cwd: String) async throws -> Data {
  do {
    return try await runGitOnce(gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("git")
    return try await runGitOnce(gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  }
}

private func runGitOnce(gitPath: String, args: [String], cwd: String) async throws -> Data {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: gitPath)
  process.arguments = args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  process.environment = gozdGitEnv()

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

/// 与えられた hash がルートコミット（親なし）かどうかを判定する。
/// `git rev-list --parents -n 1 <hash>` の出力は valid な hash であれば必ず exit 0 で
/// `<hash> <parent1> <parent2>...` の 1 行を返す。トークン数 1（hash のみ） = root、
/// 2 以上 = 非 root と判定できる。
/// invalid hash の場合は `commandFailed` が上がるためそのまま throw して上位に返す
/// （`git rev-parse <hash>^` を使うと root と invalid hash がどちらも exit 128 で
/// 区別できないため避ける）。
private func isRootCommit(dir: String, hash: String) async throws -> Bool {
  let stdout = try await runGit(args: ["rev-list", "--parents", "-n", "1", hash], cwd: dir)
  let line = String(decoding: stdout, as: UTF8.self)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  return line.split(separator: " ").count == 1
}

/// `git diff` / `git diff-tree` の `--name-status -z` 出力をパースする。
/// フォーマットは両者同一: 通常エントリ `<status>\0<path>\0`、rename/copy
/// `R<score>\0<old>\0<new>\0`（C も同様）。
private func parseDiffNameStatus(_ data: Data) -> [FileChangeInfo] {
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
  var branchHead = ""
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
    } else if line.hasPrefix("# branch.head ") {
      // HEAD が指す branch 名。`git branch -m` は OID を変えないため、
      // rename を status 経路で検知する SSOT としてこの値を保持する。
      // detached HEAD の場合は `(detached)` が返るので空文字に正規化。
      let name = String(line.dropFirst("# branch.head ".count))
      branchHead = name == "(detached)" ? "" : name
    } else if line.hasPrefix("# ") {
      // 上記以外の `# ` 行（将来追加される porcelain v2 ヘッダ）は意図的に silent drop。
      // UI 要件が立った時点でここに分岐を足す。
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
    statuses: statuses, head: head, branchHead: branchHead,
    hasUpstream: hasUpstream, ahead: ahead, behind: behind)
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
