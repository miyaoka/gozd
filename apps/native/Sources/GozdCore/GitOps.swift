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

public enum DiffHunkLineKind: Sendable {
  case context
  case added
  case removed
}

public struct DiffHunkLineInfo: Equatable, Sendable {
  public let kind: DiffHunkLineKind
  public let text: String
  public init(kind: DiffHunkLineKind, text: String) {
    self.kind = kind
    self.text = text
  }
}

public struct DiffHunkInfo: Equatable, Sendable {
  public let oldStart: UInt32
  public let oldLines: UInt32
  public let newStart: UInt32
  public let newLines: UInt32
  public let lines: [DiffHunkLineInfo]
  public init(
    oldStart: UInt32, oldLines: UInt32, newStart: UInt32, newLines: UInt32,
    lines: [DiffHunkLineInfo]
  ) {
    self.oldStart = oldStart
    self.oldLines = oldLines
    self.newStart = newStart
    self.newLines = newLines
    self.lines = lines
  }
}

public struct DiffHunksResult: Equatable, Sendable {
  public let hunks: [DiffHunkInfo]
  /// 入力 `original` の総行数 (git の line counting 規約に従う)。
  /// trailing バー / context 拡張の絶対座標計算の SSOT として renderer に返す。
  public let oldTotalLines: UInt32
  /// 入力 `current` の総行数 (git の line counting 規約に従う)。
  public let newTotalLines: UInt32
  public init(hunks: [DiffHunkInfo], oldTotalLines: UInt32, newTotalLines: UInt32) {
    self.hunks = hunks
    self.oldTotalLines = oldTotalLines
    self.newTotalLines = newTotalLines
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

  /// local ブランチ名一覧。worktree 不在の孤立 branch も含む。
  /// issue picker の `issue-<N>` 決定的命名衝突検出に使う。
  public static func branchList(dir: String) async throws -> [String] {
    let stdout = try await runGit(
      args: ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], cwd: dir)
    let text = String(decoding: stdout, as: UTF8.self)
    return text.split(whereSeparator: \.isNewline)
      .map(String.init)
      .filter { !$0.isEmpty }
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

  /// 2 つのテキスト間の hunk 単位差分と総行数を返す。
  ///
  /// 設計判断: `git diff --no-index` を使い、差分エンジンを git 本体（xdiff、C 実装）に委譲する。
  /// renderer 側で jsdiff の `diffLines` を全文に対して回すと、`pnpm-lock.yaml` のような大ファイルで
  /// Myers LCS が O(N×M) に膨れメインスレッドが固まる。git に処理を移すことで:
  ///   - LCS は C で計算され GUI スレッドを塞がない
  ///   - 結果が hunk 単位に集約されるため、renderer は不変行を全描画せず gap を静的バーで省略表示できる
  ///   - 総行数も git の line counting 規約に揃えて返すことで、trailing バー描画と context 拡張の
  ///     絶対座標計算の SSOT を Swift に置く（renderer 側 split("\n") の二重実装を排除）
  ///
  /// 実装:
  ///   - `NSTemporaryDirectory()` 配下にユニークディレクトリを作り `a` / `b` の 2 ファイルを書き出す
  ///   - `git -c diff.algorithm=myers -c diff.renames=false -c core.autocrlf=false -c core.eol=lf
  ///     diff --no-index --no-color -U3` を実行。ユーザー global config 依存で算法 / 改行扱いが
  ///     変わると hunk 境界と renderer の line counting がずれるため、本 RPC が依存するオプションを
  ///     明示固定する
  ///   - exit code は 0 (差分なし) / 1 (差分あり) のいずれも success として扱う（>1 は通常エラー扱い）
  ///   - 出力が `Binary files ... differ` 1 行の場合は呼び出し側で UTF-8 化済みのテキストを渡している
  ///     前提が破れているサイン。`GitError.commandFailed` を投げて UI に観察可能化する
  ///   - unified diff 出力を `DiffHunkInfo` 配列に parse
  public static func diffHunks(original: String, current: String) async throws -> DiffHunksResult
  {
    let tmpRoot = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    let tmpDir = tmpRoot.appendingPathComponent("gozd-diff-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    defer {
      // 削除失敗は累積すると TMPDIR を圧迫するため stderr に observable に出す。
      // throw はしない（diff 結果取得自体は成功している）。
      do {
        try FileManager.default.removeItem(at: tmpDir)
      } catch {
        FileHandle.standardError.write(
          Data("[GitOps] failed to remove diff tmp dir \(tmpDir.path): \(error)\n".utf8)
        )
      }
    }

    let aURL = tmpDir.appendingPathComponent("a")
    let bURL = tmpDir.appendingPathComponent("b")
    try Data(original.utf8).write(to: aURL)
    try Data(current.utf8).write(to: bURL)

    let stdout = try await runGitDiffNoIndex(
      args: [
        "-c", "diff.algorithm=myers",
        "-c", "diff.renames=false",
        "-c", "core.autocrlf=false",
        "-c", "core.eol=lf",
        "diff", "--no-index", "--no-color", "-U3",
        "--", aURL.path, bURL.path,
      ],
      cwd: tmpDir.path
    )
    let output = String(decoding: stdout, as: UTF8.self)

    // `git diff --no-index` は NUL バイトを検知すると hunk を生成せず
    // `Binary files <a> and <b> differ` 行を返す。実際の出力は
    //   `diff --git ...` → `index ...` → `Binary files ... differ`
    // の 3 行構成で、hunks (`@@`) と混在しない仕様。renderer 側で binary 判定をすり抜けた
    // 入力が来た場合の防御線として先頭数行のみを走査して検知する。
    // 巨大 output 全体への `contains` は本 PR の目的 (大ファイル性能改善) と矛盾するため避け、
    // file header 数行で十分なことを根拠に `prefix(8)` で打ち切る。
    // silent に hunks=[] を返すと UI 上「差分なし」に見えるため unexpectedOutput で observable に倒す。
    // `commandFailed` は exitCode != 0 を含意するため流用しない (GitError.commandFailed の case コメント参照)。
    let outputHeaderLines = output.split(separator: "\n", omittingEmptySubsequences: false).prefix(
      8)
    if outputHeaderLines.contains(where: { $0.hasPrefix("Binary files ") }) {
      throw GitError.unexpectedOutput(
        "git diff --no-index reported binary content (renderer pre-filter bypassed)"
      )
    }

    let hunks = parseUnifiedDiffHunks(output)
    return DiffHunksResult(
      hunks: hunks,
      oldTotalLines: countDiffLines(original),
      newTotalLines: countDiffLines(current)
    )
  }

  /// git の line counting 規約でテキスト行数を返す。
  /// 規約: 空文字 = 0、末尾 `\n` 有り = `\n` 区切りで作られる「終端付き行」の数、
  /// 末尾 `\n` 無し = `\n` 区切りの数 + 1（最後の `\\ No newline at end of file` で参照される行）。
  public static func countDiffLines(_ text: String) -> UInt32 {
    if text.isEmpty { return 0 }
    let parts = text.split(separator: "\n", omittingEmptySubsequences: false)
    let trailing = text.hasSuffix("\n") ? 1 : 0
    return UInt32(parts.count - trailing)
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

  /// `git rev-parse <hash>:<path>` でファイルの blob OID を返す。
  /// hash 自体が解決不能（root の `^` 等）／path 未追跡なら nil。
  /// from と to の OID が一致すれば「コミット範囲で変更なし」の SSOT 判定として使える。
  /// 失敗は nil 化するが silent drop を避けるため stderr に詳細を残す
  /// （root commit の `^` 等の想定エラーも、予期しない repo 破損も同列にログするのは
  /// `fileReadResultFromGit` と同じ規律）。
  public static func treeFileOID(dir: String, hash: String, relPath: String) async -> String? {
    do {
      let stdout = try await runGit(args: ["rev-parse", "\(hash):\(relPath)"], cwd: dir)
      let line = String(decoding: stdout, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      return line.isEmpty ? nil : line
    } catch {
      FileHandle.standardError.write(
        Data("[GitOps] rev-parse \(hash):\(relPath) failed in \(dir): \(error)\n".utf8)
      )
      return nil
    }
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

/// `git diff --no-index` 用の variant。exit 0 (差分なし) / 1 (差分あり) を共に
/// 成功扱いし stdout を返す。>1 は通常エラー扱いで throw する。
/// `git diff` は差分があると exit 1 を返す仕様で、これを runGit の標準ハンドリングに
/// 通すと throw されて stdout を失うため専用 path を用意する。
func runGitDiffNoIndex(args: [String], cwd: String) async throws -> Data {
  do {
    return try await runGitDiffNoIndexOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("git")
    return try await runGitDiffNoIndexOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  }
}

private func runGitDiffNoIndexOnce(gitPath: String, args: [String], cwd: String) async throws
  -> Data
{
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

  if process.terminationStatus <= 1 {
    return stdoutData
  }
  throw GitError.commandFailed(
    exitCode: process.terminationStatus,
    stderr: String(decoding: stderrData, as: UTF8.self))
}

/// `git diff --no-index --no-color` 出力専用の unified diff parser。
///
/// 本実装は `diffHunks` の content-based 経路のみで使う。`--no-index` + `-c diff.renames=false`
/// 固定下では file header に出現する行は `diff --git` / `index ` / `--- ` / `+++ ` のみ
/// (`--no-index` でも git は ad-hoc blob hash を計算して `index <a>..<b> <mode>` を emit する。
/// rename 系 / mode 系は本 invocation 固定下で emit されない)。
/// 汎用 unified diff (`git diff <hash>..<hash>` 等) との両用にすると whitelist がぶれて
/// unexpectedSkips の計上閾値が曖昧になるため、本 parser は `--no-index` 専用と明示する。
///
/// 各 hunk は `@@ -oldStart[,oldLines] +newStart[,newLines] @@` ヘッダで始まり、
///   ` ` 行 = context
///   `-` 行 = removed (original 側のみ)
///   `+` 行 = added (current 側のみ)
///   `\` 行 = `\\ No newline at end of file` の装飾。読み飛ばす
/// で構成される。`diff --git` / `---` / `+++` ヘッダは無視する。
///
/// `oldLines` / `newLines` は count 省略時 1 として扱う（unified diff 仕様）。
func parseUnifiedDiffHunks(_ text: String) -> [DiffHunkInfo] {
  var hunks: [DiffHunkInfo] = []
  var lines = text.split(separator: "\n", omittingEmptySubsequences: false)
  // `text` が `\n` で終わる場合、split は末尾に空 Substring を 1 つ作る。これは
  // 改行終端の正規アーティファクトなので「想定外行」計上の対象から外す。
  if lines.last?.isEmpty == true {
    lines.removeLast()
  }
  // unified diff の想定外行 (file header / hunk header / 既知 marker 以外) を skip した件数。
  // 想定通り 0 のはずなので、>0 で出力された場合はパーサと git 出力の乖離として stderr に出す。
  var unexpectedSkips = 0

  var i = 0
  while i < lines.count {
    let raw = lines[i]
    guard raw.hasPrefix("@@") else {
      // `--no-index` モードで file header に出る行は `diff --git` / `index ` / `--- ` / `+++ `。
      // `--no-index` でも git は両ファイルの blob OID を計算して `index <a>..<b> <mode>` を emit する。
      // rename / mode 系は `-c diff.renames=false` 固定下では出ないため whitelist には含めない。
      // 上記以外の prefix が来たら hunk 探索中の異常 → 計上する。
      if !raw.isEmpty
        && !raw.hasPrefix("diff ") && !raw.hasPrefix("index ")
        && !raw.hasPrefix("--- ") && !raw.hasPrefix("+++ ")
      {
        unexpectedSkips += 1
      }
      i += 1
      continue
    }
    guard let header = parseHunkHeader(String(raw)) else {
      // `@@` で始まるが header 形式に合わない行は parser バグか git 出力の変化。
      FileHandle.standardError.write(
        Data("[GitOps] unparseable hunk header: \(raw)\n".utf8))
      i += 1
      continue
    }
    var hunkLines: [DiffHunkLineInfo] = []
    i += 1
    while i < lines.count {
      let l = lines[i]
      if l.hasPrefix("@@") || l.hasPrefix("diff ") || l.hasPrefix("--- ")
        || l.hasPrefix("+++ ")
      {
        break
      }
      if l.hasPrefix("\\") {
        // `\ No newline at end of file` は装飾、無視
        i += 1
        continue
      }
      // hunk 本文中の prefix は ` ` / `+` / `-` のいずれか (unified diff 規約)。
      // 空 Substring は split による trailing empty の可能性があるが、その場合は
      // hunk 内ではなく hunk 直後の末尾位置にしか出現しない想定。
      guard let first = l.first else {
        unexpectedSkips += 1
        i += 1
        continue
      }
      let rest = String(l.dropFirst())
      let kind: DiffHunkLineKind
      switch first {
      case " ": kind = .context
      case "+": kind = .added
      case "-": kind = .removed
      default:
        unexpectedSkips += 1
        i += 1
        continue
      }
      hunkLines.append(DiffHunkLineInfo(kind: kind, text: rest))
      i += 1
    }
    hunks.append(
      DiffHunkInfo(
        oldStart: header.oldStart,
        oldLines: header.oldLines,
        newStart: header.newStart,
        newLines: header.newLines,
        lines: hunkLines
      ))
  }
  if unexpectedSkips > 0 {
    FileHandle.standardError.write(
      Data("[GitOps] parseUnifiedDiffHunks: skipped \(unexpectedSkips) unexpected line(s)\n".utf8))
  }
  return hunks
}

private struct HunkHeader {
  let oldStart: UInt32
  let oldLines: UInt32
  let newStart: UInt32
  let newLines: UInt32
}

private func parseHunkHeader(_ line: String) -> HunkHeader? {
  // 例: "@@ -1,5 +1,7 @@" / "@@ -1 +1 @@" / "@@ -0,0 +1,3 @@ optional ctx"
  let pattern = #"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@"#
  guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
  let ns = line as NSString
  let range = NSRange(location: 0, length: ns.length)
  guard let m = re.firstMatch(in: line, range: range) else { return nil }

  // count 省略時の規約値 (unified diff 仕様)。
  // 数値部の `UInt32` 変換は失敗を default で握ると observability を奪うため
  // header parse 失敗として nil を返し、呼び出し側で stderr に出させる。
  let oldStart = UInt32(ns.substring(with: m.range(at: 1)))
  let newStart = UInt32(ns.substring(with: m.range(at: 3)))
  guard let oldStart, let newStart else { return nil }

  let oldLinesRange = m.range(at: 2)
  let newLinesRange = m.range(at: 4)
  let oldLines: UInt32
  if oldLinesRange.location == NSNotFound {
    oldLines = 1
  } else if let v = UInt32(ns.substring(with: oldLinesRange)) {
    oldLines = v
  } else {
    return nil
  }
  let newLines: UInt32
  if newLinesRange.location == NSNotFound {
    newLines = 1
  } else if let v = UInt32(ns.substring(with: newLinesRange)) {
    newLines = v
  } else {
    return nil
  }
  return HunkHeader(
    oldStart: oldStart, oldLines: oldLines, newStart: newStart, newLines: newLines)
}

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
