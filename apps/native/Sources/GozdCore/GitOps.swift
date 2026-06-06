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

  /// `git fetch --all --no-write-fetch-head` 相当。背景自動 fetch 用。
  ///
  /// - `--all`: 全 remote を fetch。upstream が `origin` 以外 (fork PR workflow で
  ///   upstream=upstream / origin=fork 等) でも UI の ahead/behind を最新化できる。
  ///   VSCode autofetch の `"all"` モード相当
  /// - `--no-write-fetch-head`: `FETCH_HEAD` を書き換えない。`FETCH_HEAD` は手動
  ///   `git pull` の起点としてユーザーが意識する短期記憶で、背景 fetch が
  ///   上書きするとユーザーの「最後に fetch した内容」感覚が壊れる
  /// - `--prune` は付けない: リモートで削除された branch がローカル refs から消えると
  ///   サイドバー表示も同期して消え、ユーザーが混乱する。明示操作に残す
  /// - `--tags` は付けない: 重く、ahead/behind 計算には不要
  ///
  /// 非対話化:
  ///
  /// - `GIT_TERMINAL_PROMPT=0`: HTTPS の credential prompt を抑止し、認証情報が
  ///   無い場合は即座に exit 128 で失敗させる (hang 防止)
  /// - `GIT_SSH_COMMAND` 末尾に ` -o BatchMode=yes`: SSH の passphrase / known_hosts
  ///   prompt を抑止。agent / key が無効なら即失敗
  ///
  /// 失敗は throw する。呼び出し側で「offline / 認証失敗等は静かに飲み込む」判断をする。
  public static func fetchRemotes(dir: String) async throws {
    _ = try await runGitNonInteractive(
      args: ["fetch", "--all", "--no-write-fetch-head"], cwd: dir)
  }

  public struct LogResult: Sendable {
    public let headCommits: [CommitInfo]
    public let defaultBranchCommits: [CommitInfo]
    public let defaultBranch: String
    /// HEAD の upstream を始点とする log。upstream 未設定 / default branch と一致 /
    /// currentBranchOnly / git log 失敗 のときは空配列。
    public let upstreamCommits: [CommitInfo]
    /// 解決された upstream ref 名 (例: `origin/foo`)。未設定なら空文字。
    public let upstreamRef: String
  }

  /// HEAD と default branch（origin/HEAD）と HEAD の upstream の log を返す。
  ///
  /// エラー方針:
  /// - `commandFailed`（origin 未設定 / unborn branch 等のドメイン失敗）は空文字列 / 空配列に倒す
  /// - `launchFailed`（shell spawn 失敗 / hang）は rethrow して上位の `notify.error` まで通す
  /// - `commandNotFound`（git CLI 未インストール）も rethrow（`catch` していないので自動的に
  ///   propagate する。renderer 側で「インストールしてください」UI を出す前提）
  ///
  /// `try?` で 3 種を区別せず潰すと、git-graph が「空」「gozd が git を解決できていない」
  /// 「ユーザーが git をインストールしていない」を見分けられなくなる。
  ///
  /// upstream 系統を第 3 ストリームとして fetch する理由:
  /// HEAD の git log は HEAD 系統の祖先しか walk しない。`origin/foo` が指す commit が
  /// amend / reset / rebase 等で HEAD から到達不可になると、その commit が visible commit set
  /// に含まれず `git log --decorate` の `%D` にも `origin/foo` が現れない。第 3 ストリームで
  /// upstream tip を始点に追加 walk することで、orphan 化した upstream ref も graph に
  /// badge として現れるようにする。
  public static func logBoth(
    dir: String, maxCount: UInt32, firstParentOnly: Bool, currentBranchOnly: Bool
  ) async throws
    -> LogResult
  {
    async let headTask = log(
      dir: dir, ref: "HEAD", maxCount: maxCount, firstParentOnly: firstParentOnly)
    async let upstreamRefTask = upstreamRefName(dir: dir)
    let defaultBranch: String
    do {
      defaultBranch = try await defaultBranchName(dir: dir)
    } catch GitError.commandFailed {
      defaultBranch = ""
    }
    let upstreamRef = await upstreamRefTask
    let head = try await headTask
    var defaultCommits: [CommitInfo] = []
    // currentBranchOnly では default branch 系統の log fetch を skip する。`defaultBranch` 文字列は
    // `symbolic-ref` だけは引き続き解決して返す (renderer の RefBadge `isDefault` 表示に使う)。
    if !defaultBranch.isEmpty && !currentBranchOnly {
      do {
        defaultCommits = try await log(
          dir: dir, ref: "origin/\(defaultBranch)", maxCount: maxCount,
          firstParentOnly: firstParentOnly)
      } catch GitError.commandFailed {
        defaultCommits = []
      }
    }
    // upstream 系統。default branch と同一なら重複 fetch を避けて skip する。
    // upstreamRef は ref 名のまま返し、commits だけ空にする (renderer の表示分岐用)。
    var upstreamCommits: [CommitInfo] = []
    if !upstreamRef.isEmpty && !currentBranchOnly
      && upstreamRef != "origin/\(defaultBranch)"
    {
      do {
        upstreamCommits = try await log(
          dir: dir, ref: upstreamRef, maxCount: maxCount,
          firstParentOnly: firstParentOnly)
      } catch GitError.commandFailed {
        upstreamCommits = []
      }
    }
    return LogResult(
      headCommits: head, defaultBranchCommits: defaultCommits, defaultBranch: defaultBranch,
      upstreamCommits: upstreamCommits, upstreamRef: upstreamRef)
  }

  /// HEAD の upstream ref 名を返す (例: `origin/foo`)。
  /// upstream 未設定 / detached HEAD / git 解決失敗 では空文字列を返す。
  /// `commandFailed` 以外 (launchFailed / commandNotFound) は呼び出し側に伝播せず、
  /// graph 描画を止めないよう空文字列に倒す。これは upstream 解決が graph 表示の
  /// 必須経路ではなく、HEAD の log 自体は別系統で取れるため。
  public static func upstreamRefName(dir: String) async -> String {
    do {
      let stdout = try await runGit(
        args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd: dir)
      return String(decoding: stdout, as: UTF8.self).trimmingCharacters(
        in: .whitespacesAndNewlines)
    } catch {
      return ""
    }
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
        StderrLog.write(
          tag: "GitOps", "failed to remove diff tmp dir \(tmpDir.path): \(error)")
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

  /// `countDiffLines` と同じ規約で text を 1 行ずつの配列に分解する。
  /// 末尾 `\n` 有りの場合は最後の空要素を除外する (git の line counting に揃える)。
  /// 添字は 0-based。1-based の絶対座標から引くときは呼び出し側で `- 1` する。
  ///
  /// `internal` で公開する: `countDiffLines` と `expandDiffLines` の 2 つの public 関数が
  /// 内部で共有する正規化ロジックであり、外部 RPC ハンドラから直接呼ぶ用途は無い。
  /// テストからは `@testable import GozdCore` 経由で境界整合 (`split.count == count`) を検証する。
  static func splitDiffLines(_ text: String) -> [String] {
    if text.isEmpty { return [] }
    let parts = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    let trailing = text.hasSuffix("\n") ? 1 : 0
    return Array(parts.prefix(parts.count - trailing))
  }

  /// hunk-bar クリック展開用に original / current 全文から指定行範囲を切り出す。
  ///
  /// 1-based。`oldStart` / `newStart` から `lines` 行分を取得して `(oldLineNo, newLineNo, oldText, newText)`
  /// のタプル配列で返す。`countDiffLines` と同じ line counting 規約で行配列化することで、
  /// renderer 側の `text.split("\n").length` との末尾 1 行ずれを起こさない。
  ///
  /// 範囲外は silent に空文字を返さず `GitError.unexpectedOutput` を投げて observable に倒す
  /// (CLAUDE.md `fallback せずエラーにする` 規約)。
  public static func expandDiffLines(
    original: String,
    current: String,
    oldStart: UInt32,
    newStart: UInt32,
    lines: UInt32
  ) throws -> [(oldLineNo: UInt32, newLineNo: UInt32, oldText: String, newText: String)] {
    if lines == 0 { return [] }
    let oldLines = splitDiffLines(original)
    let newLines = splitDiffLines(current)
    let oldEnd = Int(oldStart) + Int(lines) - 1
    let newEnd = Int(newStart) + Int(lines) - 1
    guard oldStart >= 1, newStart >= 1, oldEnd <= oldLines.count, newEnd <= newLines.count else {
      throw GitError.unexpectedOutput(
        "expandDiffLines out of range: oldStart=\(oldStart) newStart=\(newStart) lines=\(lines) "
          + "oldTotal=\(oldLines.count) newTotal=\(newLines.count)"
      )
    }
    var result:
      [(oldLineNo: UInt32, newLineNo: UInt32, oldText: String, newText: String)] = []
    result.reserveCapacity(Int(lines))
    for k in 0..<Int(lines) {
      let oNo = Int(oldStart) - 1 + k
      let nNo = Int(newStart) - 1 + k
      result.append((
        oldLineNo: UInt32(oNo + 1),
        newLineNo: UInt32(nNo + 1),
        oldText: oldLines[oNo],
        newText: newLines[nNo]
      ))
    }
    return result
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
      StderrLog.write(
        tag: "GitOps", "rev-parse \(hash):\(relPath) failed in \(dir): \(error)")
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

  /// PR diff: `baseHash` から working tree までの tracked file の name-status 差分を返す。
  ///
  /// 「PR をいま push したら base に何が入るか」のうち **commit 済み + uncommitted (tracked)** を担う
  /// 専用 entry point。`commitFiles` の range 経路 + olderIsBase=true で代用していた構造を解体し、
  /// proto の `rangeHashes` (first-parent walk 結果) wire 契約と切り離す。
  ///
  /// untracked file の merge は本関数では行わない。renderer 側 (`useChangesStore.fileChanges`) が
  /// `gitStatusStore` 由来の untracked を append する SSOT に一本化したため、untracked を `U` として
  /// 写す責務は renderer の 1 か所に閉じる (range + working-tree 端の経路と同一層に揃える)。
  ///
  /// 実装:
  /// - `git diff --name-status -z --find-renames --diff-filter=AMDR <baseHash>` で base..working
  ///   (右辺省略 = working tree)。rename は `--find-renames` が `R` として解決する。
  public static func prDiffFiles(dir: String, baseHash: String) async throws -> [FileChangeInfo] {
    // baseHash は GitHub の `baseRefOid` (実在 commit OID) が契約。`validateRev` は empty を許す
    // 設計のため、commit OID 必須の `lsTree` / `resetMixed` と同じ二段ガードで empty / all-zero を
    // 入口で reject する (empty を素通りさせると `git diff` が rev なしの別 semantic で走るため)。
    if baseHash.isEmpty {
      throw GitError.unexpectedOutput("git diff: base hash must be specified")
    }
    if isAllZeroHex(baseHash) {
      throw GitError.unexpectedOutput(
        "git diff: all-zero hash (UNCOMMITTED_HASH) is not a valid PR base")
    }
    try validateRev(baseHash)
    let diffOptions = ["--name-status", "-z", "--find-renames", "--diff-filter=AMDR"]
    let diffOut = try await runGit(args: ["diff"] + diffOptions + [baseHash], cwd: dir)
    return parseDiffNameStatus(diffOut)
  }

  /// 指定 rev (commit OID) が local repo に reachable か。`git cat-file -e <hash>` 相当。
  ///
  /// PR diff toggle ON 時に base OID が未 fetch かを判定し、fetch 要求 (`useRemoteFetchSync`
  /// 経由) を必要最小限に絞るために使う。reachable=false でも throw せず bool で返す契約に
  /// することで、呼び出し側は「git failure」と「reachable でないだけ」を構造的に区別できる。
  ///
  /// `validateRev` 失敗 (`-` 始まり等の option 注入 / 非 hex) は false に倒すが、これは
  /// 「reachable でない」とは別レイヤの input bug なので stderr に観察可能ログを残す
  /// (CLAUDE.md `silent drop は禁止` 規律)。
  public static func revReachable(dir: String, hash: String) async -> Bool {
    do {
      try validateRev(hash)
    } catch {
      StderrLog.write(tag: "GitOps", "revReachable: invalid rev '\(hash)': \(error)")
      return false
    }
    do {
      _ = try await runGit(args: ["cat-file", "-e", hash], cwd: dir)
      return true
    } catch {
      return false
    }
  }

  /// 指定コミットの tree から 1 階層分のエントリを返す。
  ///
  /// 契約: `path` が空文字なら repo root の 1 階層、それ以外は末尾 `/` を必ず付けて
  /// `git ls-tree -z <hash> <path>/` を実行する。末尾 `/` を外すと git はそのエントリ 1 件
  /// (tree 自身) を返すため、lazy expand の 1 階層列挙にならない。
  ///
  /// hash は空文字 / all-zero hex (UNCOMMITTED_HASH) を reject する。snapshot mode は明示的な
  /// commit 指定が前提で、UNCOMMITTED_HASH を送ると `git ls-tree` は `fatal: Not a valid object
  /// name 0000...` を返すが、その文言から「呼び出し側が UNCOMMITTED_HASH を流した SSOT 違反」を
  /// 即診断できないため入口で明示 reject する。validateRev に通すことで `-` 始まり等の option
  /// 注入も構造的に弾く。
  ///
  /// path は `validateRelPath` で先頭 `-` (option 注入) / 絶対パス / `..` traversal を reject
  /// する。renderer は worktree 相対 path を送る契約のため、ここで違反したら呼び出し側のバグ。
  public static func lsTree(dir: String, hash: String, path: String) async throws
    -> [GitTreeEntryInfo]
  {
    if hash.isEmpty {
      throw GitError.unexpectedOutput("git ls-tree: hash must be specified")
    }
    if isAllZeroHex(hash) {
      throw GitError.unexpectedOutput(
        "git ls-tree: all-zero hash (UNCOMMITTED_HASH) is not a valid commit")
    }
    try validateRev(hash)
    try validateRelPath(path)
    var args = ["ls-tree", "-z", hash]
    if !path.isEmpty {
      args.append(path.hasSuffix("/") ? path : path + "/")
    }
    let stdout = try await runGit(args: args, cwd: dir)
    return try parseLsTree(stdout)
  }

  /// active worktree の現在 branch を指定コミットへ `git reset --mixed <hash>` で移動する。
  ///
  /// `--mixed` は branch ref を <hash> に動かし index を <hash> に reset するが working tree の
  /// ファイルは書き換えない。git-graph の commit 行の右クリックメニューから呼ぶ。
  ///
  /// hash は `lsTree` と同じ規律で検証する: 空文字 / all-zero hex (UNCOMMITTED_HASH) を reject し、
  /// `validateRev` で `-` 始まり (option 注入) / 非 hex を弾く。working tree への reset は意味を
  /// 持たないため renderer は commit 行以外でこの RPC を呼ばない契約だが、入口で構造的に守る。
  public static func resetMixed(dir: String, hash: String) async throws {
    if hash.isEmpty {
      throw GitError.unexpectedOutput("git reset: hash must be specified")
    }
    if isAllZeroHex(hash) {
      throw GitError.unexpectedOutput(
        "git reset: all-zero hash (UNCOMMITTED_HASH) is not a valid commit")
    }
    try validateRev(hash)
    // `--` で hash を pathspec から分離し、option / pathspec 誤解釈の余地を残さない。
    _ = try await runGit(args: ["reset", "--mixed", hash, "--"], cwd: dir)
  }

  /// 単一行の blame 結果。`git blame --porcelain -L <line>,<line> [<rev>] -- <relPath>` を
  /// 1 行ぶんに絞ってヘッダ + メタ行のみを parse する。
  ///
  /// rev が空文字なら rev を渡さず working tree を blame。working tree の未コミット行は
  /// porcelain ヘッダの sha が全 0 で返るため `notCommitted` フラグに倒す。
  ///
  /// `--incremental` を使わない理由: 1 行 RPC 用途では出力は数行で、`--porcelain` の方が
  /// すべてのメタ行が必ず付随する保証があり parse 規約が簡単。
  ///
  /// 大ファイル保護: blame は出力が 1 行でも対象ファイル全体を walk するため、
  /// `pnpm-lock.yaml` 級 (数 MB) のファイルでブロックする。`git cat-file -s` で
  /// blob サイズを先に測り `BLAME_MAX_BLOB_BYTES` を超えたら `commandFailed` 互換で reject。
  public static func blameLine(dir: String, relPath: String, rev: String, line: UInt32)
    async throws -> BlameLineInfo
  {
    try validateRev(rev)
    try await ensureBlameableSize(dir: dir, rev: rev, relPath: relPath)
    var args = ["blame", "--porcelain", "-L", "\(line),\(line)"]
    if !rev.isEmpty { args.append(rev) }
    args.append("--")
    args.append(relPath)
    let stdout = try await runGit(args: args, cwd: dir)
    let text = String(decoding: stdout, as: UTF8.self)

    var hash = ""
    var sourceLine: UInt32 = line
    var author = ""
    var authorMail = ""
    var authorTime: Int64 = 0
    var summary = ""
    var headerSeen = false
    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
      // CRLF 等の trailing whitespace で `Int64(...)` parse が失敗して
      // authorTime が 0 に倒れるのを防ぐため trim する。
      let s = String(rawLine).trimmingCharacters(in: .whitespacesAndNewlines)
      if rawLine.first == "\t" {
        // ソース行本体。--porcelain は 1 回だけ出力する。以降のメタ行はないので break。
        // trim 前の文字を見ないと先頭タブが落ちて誤判定する。
        break
      }
      if !headerSeen {
        // 最初の非タブ行はヘッダ: "<sha> <orig_line> <final_line> [<group_size>]"
        let parts = s.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        if parts.count >= 3 {
          hash = parts[0]
          if let n = UInt32(parts[1]) { sourceLine = n }
        }
        headerSeen = true
        continue
      }
      if s.hasPrefix("author ") {
        author = String(s.dropFirst("author ".count))
      } else if s.hasPrefix("author-mail ") {
        // `<email>` 形式で囲まれる。<> を剥がして mailto-friendly に。
        let raw = String(s.dropFirst("author-mail ".count))
        if raw.hasPrefix("<") && raw.hasSuffix(">") {
          authorMail = String(raw.dropFirst().dropLast())
        } else {
          authorMail = raw
        }
      } else if s.hasPrefix("author-time ") {
        if let n = Int64(s.dropFirst("author-time ".count)) { authorTime = n }
      } else if s.hasPrefix("summary ") {
        summary = String(s.dropFirst("summary ".count))
      }
    }

    if hash.isEmpty {
      throw GitError.unexpectedOutput("git blame: missing porcelain header")
    }
    let notCommitted = hash.allSatisfy { $0 == "0" }
    let shortHash = String(hash.prefix(7))
    return BlameLineInfo(
      hash: hash,
      shortHash: shortHash,
      author: author,
      authorMail: authorMail,
      authorTime: authorTime,
      summary: summary,
      sourceLine: sourceLine,
      notCommitted: notCommitted
    )
  }

  /// 単一行の変更履歴。`git log -L<line>,<line>:<relPath> --no-patch <rev>` 相当。
  ///
  /// `--no-patch` で diff 本体を抑制し、custom `--format` で commit metadata のみ取り出す。
  /// 既存 `log` と同じ %x1f / %x1e 区切りに揃えて parse ロジックを共有する。
  ///
  /// path に `:` を含む場合は `-L<n>,<n>:<path>` の syntax が壊れるため reject。
  /// rev は `validateRev` で `-` 始まり等の option 注入を弾き、加えて **空文字も reject** する。
  /// 本 RPC は呼び出し側 (`useBlamePopover`) が必ず blame した commit hash を起点として
  /// 流す契約のため、rev="" で HEAD 起点 walk に倒れると「blame した commit を含まない
  /// history」が返って意味契約が壊れる。SSOT 違反を構造的に防ぐため空文字は明示 reject。
  public static func logLine(
    dir: String, relPath: String, rev: String, line: UInt32, maxCount: UInt32
  ) async throws -> [CommitInfo] {
    if rev.isEmpty {
      throw GitError.unexpectedOutput(
        "git log -L: rev must be specified (empty rev would walk HEAD and break the "
          + "blame-anchored contract)")
    }
    try validateRev(rev)
    if relPath.contains(":") {
      // git log -L の `-L<n>,<n>:<path>` は `:` を separator として使うため、
      // path に `:` を含むと正しく parse されない。仕様上の制約のため明示 reject。
      throw GitError.unexpectedOutput("git log -L: path contains ':', which is unsupported")
    }
    let format = "%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s%x1f%b%x1f%D%x1e"
    var args = [
      "log",
      "--format=\(format)",
      "--decorate=short",
      "--no-patch",
      "-L", "\(line),\(line):\(relPath)",
    ]
    if maxCount > 0 { args.append("--max-count=\(maxCount)") }
    args.append(rev)
    let stdout = try await runGit(args: args, cwd: dir)
    let text = String(decoding: stdout, as: UTF8.self)
    var commits: [CommitInfo] = []
    for record in text.split(separator: "\u{1e}", omittingEmptySubsequences: true) {
      let trimmed = record.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      let parts = trimmed.split(separator: "\u{1f}", omittingEmptySubsequences: false).map(
        String.init)
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
}

/// blame 対象ファイルのサイズ上限。これを超えると blame は秒オーダーでブロックするため
/// 早期に reject する。閾値は GitHub の blame UI のハード上限と同等の目安。
/// `internal` にして `@testable import GozdCore` で boundary テストから直接参照できるようにする。
let BLAME_MAX_BLOB_BYTES = 2 * 1024 * 1024

/// `rev` 文字列を `git` 引数として安全に渡せるか検証する。
///
/// 役割: **option 注入を弾く safety net**。長さ check や git revision syntax の完全再現は
/// 行わない (git 自身が revision parse で reject するため二重実装は避ける)。
///
/// 許可: 空文字 / "HEAD" / 先頭が 16 進文字 (`[0-9a-fA-F]`) で全体が hex + `^` + `~` で構成される文字列。
/// reject: `-` 始まり (option 解釈の余地) / 非 hex 始まり (`main` 等の named ref) / 空白文字 / hex 外の記号。
///
/// 本 RPC が想定する rev 計算経路 (`""` / `"HEAD"` / `<hash>` / `<hash>^` / `<hash>~N`) に
/// 限定する設計判断: hex hash + 末尾 `^` `~N` の組み合わせのみが renderer から流れる契約のため。
/// `HEAD^` / `HEAD~` のような named ref + suffix は本 RPC ではサポートしない (renderer は
/// 必ず hash 化してから流す契約)。
///
/// `internal` にして `@testable import GozdCore` で boundary テストから直接呼べるようにする。
func validateRev(_ rev: String) throws {
  if rev.isEmpty { return }
  if rev == "HEAD" { return }
  let allowed: Set<Character> = Set("0123456789abcdefABCDEF^~")
  guard let first = rev.first else { return }
  // `-` 始まりは絶対禁止 (option 解釈の余地)。
  if first == "-" {
    throw GitError.unexpectedOutput("git rev validation: leading '-' is not allowed: \(rev)")
  }
  // 先頭は 16 進数のいずれかでなければならない。HEAD 等の名前付き ref は本 RPC では使わない契約。
  let hexChars: Set<Character> = Set("0123456789abcdefABCDEF")
  guard hexChars.contains(first) else {
    throw GitError.unexpectedOutput("git rev validation: must start with hex digit: \(rev)")
  }
  for c in rev {
    if !allowed.contains(c) {
      throw GitError.unexpectedOutput("git rev validation: invalid character in rev: \(rev)")
    }
  }
  // 数字も含むため digit-only な短い列を hash と誤認することがあるが、
  // git 自身が revision parse で reject するので 2 重にチェックしない。
}

/// 全 0 hex (`0000000000...`) かどうか。renderer 側の `UNCOMMITTED_HASH` sentinel と一致する。
/// `validateRev` は hex 文字列を通すため別途明示的に弾く必要がある (lsTree 等の
/// 「コミット指定が必須」な RPC 入口での safety net)。
func isAllZeroHex(_ s: String) -> Bool {
  if s.isEmpty { return false }
  for c in s {
    if c != "0" { return false }
  }
  return true
}

/// path が worktree 相対パスとして git 引数に渡せるか検証する。
///
/// 役割: **option 注入と sandbox 逸脱を弾く safety net**。renderer は worktree 相対 path を
/// 送る契約のため、ここで違反したら呼び出し側のバグ (新規 RPC consumer / refactor 由来) で、
/// 表面化させて即診断できるようにする。
///
/// 許可: 空文字 / worktree 相対の通常 path。
/// reject: `-` 始まり (option 注入) / `/` 始まり (絶対パス) / `..` を含む traversal /
///   空白文字 / NUL byte / 改行を含むもの。
func validateRelPath(_ path: String) throws {
  if path.isEmpty { return }
  if path.hasPrefix("-") {
    throw GitError.unexpectedOutput("git path validation: leading '-' is not allowed: \(path)")
  }
  if path.hasPrefix("/") {
    throw GitError.unexpectedOutput("git path validation: absolute path is not allowed: \(path)")
  }
  for component in path.split(separator: "/", omittingEmptySubsequences: false) {
    if component == ".." {
      throw GitError.unexpectedOutput(
        "git path validation: '..' traversal is not allowed: \(path)")
    }
  }
  for c in path {
    if c == "\0" || c == "\n" || c == "\r" {
      throw GitError.unexpectedOutput(
        "git path validation: control character is not allowed: \(path)")
    }
  }
}

/// blame 実行前にファイルサイズが上限以下かを確認する。
/// rev 指定時は `git cat-file -s <rev>:<relPath>`、working tree (rev="") なら fs stat。
///
/// 観察可能性: silent fallback は **想定された "存在しない" 経路のみ** に限定する。
/// - working tree: file-not-found (`NSFileReadNoSuchFileError`) のみ silent 通過。
///   blame は同条件で git の「no such path」エラーに倒れて RPC error として表面化する
/// - rev 指定: `git cat-file -s` の `commandFailed`（exit 128 等、path 未解決 / 不正 rev）のみ
///   silent 通過。`launchFailed` / `commandNotFound` / `unexpectedOutput` は再 throw して
///   観察可能化する。これらは「予期しない異常」で blame に進むと UI ブロックが救えない
private func ensureBlameableSize(dir: String, rev: String, relPath: String) async throws {
  let bytes: Int
  if rev.isEmpty {
    // working tree。Path を URL で組み立てて `FileManager.attributesOfItem` で読む。
    let fileURL = URL(fileURLWithPath: dir, isDirectory: true)
      .appendingPathComponent(relPath, isDirectory: false)
    do {
      let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
      bytes = (attrs[.size] as? Int) ?? 0
    } catch let nsError as NSError {
      // file-not-found のみ「blame 側で notFound として表面化させる」silent 経路。
      // permission / I/O 異常等は throw して隠さない。
      if nsError.domain == NSCocoaErrorDomain
        && nsError.code == NSFileReadNoSuchFileError
      {
        return
      }
      throw nsError
    }
  } else {
    do {
      let stdout = try await runGit(
        args: ["cat-file", "-s", "\(rev):\(relPath)"], cwd: dir)
      let s = String(decoding: stdout, as: UTF8.self).trimmingCharacters(
        in: .whitespacesAndNewlines)
      // exit 0 で stdout が非数値 (repo 破損 / 想定外フォーマット) の場合に
      // `?? 0` で 0 化すると size gate を素通りして blame に進んでしまう。
      // 観察可能化のため throw に倒す ("fallback せずエラーにする" 規約)。
      guard let parsed = Int(s) else {
        throw GitError.unexpectedOutput("git cat-file -s returned unparseable size: \(s)")
      }
      bytes = parsed
    } catch GitError.commandFailed {
      // exit code != 0: root commit の `^` / 未追跡 path / invalid rev 等で `cat-file` が
      // 失敗するケースのみ silent 通過。blame 側でも同 rev:path が解決失敗するため
      // RPC error として一貫した経路で表面化する。
      return
    }
    // launchFailed / commandNotFound / unexpectedOutput / その他は再 throw して観察可能化する
  }
  if bytes > BLAME_MAX_BLOB_BYTES {
    throw GitError.unexpectedOutput(
      "git blame: file too large (\(bytes) bytes > \(BLAME_MAX_BLOB_BYTES))")
  }
}

/// `git ls-tree -z <hash> <path>/` の 1 エントリ。
///
/// type は git mode → 文字列の写像で、SSOT は `typeFromGitMode`:
///   - 040000 → "directory"
///   - 120000 → "symlink"
///   - 160000 → "submodule"
///   - 100644 / 100755 / その他 → "file"
public struct GitTreeEntryInfo: Equatable, Sendable {
  public let name: String
  public let type: String
  public init(name: String, type: String) {
    self.name = name
    self.type = type
  }
}

/// `git ls-tree -z` の NUL 区切り出力を parse する。
///
/// 各レコード形式: `<mode> SP <type> SP <object> TAB <path>`。`path` 末尾 `/` 付きで
/// 呼んだ場合 `<path>` は "<parent>/<basename>" になるため basename だけ抽出する。
///
/// 想定外フォーマットは silent skip せず `unexpectedOutput` で throw する。
/// silent skip すると「N entries あるはずが N-1 件表示」という不整合が UI 上で観察不能になる
/// (CLAUDE.md "fallback せずエラーにする" と整合)。git ls-tree -z の出力形式は git のバージョン
/// 間で stable な契約のため、ここで throw した時点で git 側 / 入力 hash 側 / 想定外環境 のいずれか
/// の異常が即診断できる。
func parseLsTree(_ data: Data) throws -> [GitTreeEntryInfo] {
  // `String(decoding:as:)` は不正 UTF-8 を U+FFFD で lossy 置換するため、Linux 等で
  // 非 UTF-8 ファイル名がコミットされた場合に置換文字混じりの name が UI まで流れる。
  // `String(bytes:encoding:)` で UTF-8 失敗を明示検出して `unexpectedOutput` に倒す
  // (runTestGit helper の stderr 扱いと同じ規律、CLAUDE.md "fallback せずエラーにする" と整合)。
  guard let text = String(bytes: data, encoding: .utf8) else {
    throw GitError.unexpectedOutput("git ls-tree: non-UTF-8 output (\(data.count) bytes)")
  }
  var result: [GitTreeEntryInfo] = []
  for record in text.split(separator: "\0", omittingEmptySubsequences: true) {
    let tabSplit = record.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
    if tabSplit.count != 2 {
      throw GitError.unexpectedOutput(
        "git ls-tree: record missing TAB separator: \(String(record))")
    }
    let header = tabSplit[0]
    let fullPath = String(tabSplit[1])
    let headerParts = header.split(
      separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
    if headerParts.count != 3 {
      throw GitError.unexpectedOutput(
        "git ls-tree: header expected 3 SP-delimited fields: \(String(header))")
    }
    let mode = String(headerParts[0])
    let basename = (fullPath as NSString).lastPathComponent
    if basename.isEmpty {
      throw GitError.unexpectedOutput("git ls-tree: empty basename in record: \(String(record))")
    }
    result.append(GitTreeEntryInfo(name: basename, type: typeFromGitMode(mode)))
  }
  return result.sorted { $0.name < $1.name }
}

/// git ls-tree の mode (`040000` / `120000` / ...) を FileEntry kind の文字列に写像する。
/// `internal` は `@testable import GozdCore` で boundary テストから直接呼ぶため。
func typeFromGitMode(_ mode: String) -> String {
  switch mode {
  case "040000": return "directory"
  case "120000": return "symlink"
  case "160000": return "submodule"
  default: return "file"
  }
}

/// 単一行の blame 結果。
public struct BlameLineInfo: Equatable, Sendable {
  public let hash: String
  public let shortHash: String
  public let author: String
  public let authorMail: String
  public let authorTime: Int64
  public let summary: String
  public let sourceLine: UInt32
  public let notCommitted: Bool
  public init(
    hash: String, shortHash: String, author: String, authorMail: String, authorTime: Int64,
    summary: String, sourceLine: UInt32, notCommitted: Bool
  ) {
    self.hash = hash
    self.shortHash = shortHash
    self.author = author
    self.authorMail = authorMail
    self.authorTime = authorTime
    self.summary = summary
    self.sourceLine = sourceLine
    self.notCommitted = notCommitted
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

/// 非対話 git 起動用の env を組み立てる。pure function (テスト可能)。
///
/// - `GIT_TERMINAL_PROMPT=0`: HTTPS credential prompt を抑止
/// - `GIT_SSH_COMMAND` には ` -o BatchMode=yes` を末尾に追記する。完全上書きすると
///   ユーザーが ProxyCommand 等を env に設定しているケースを壊すため、既存値を保つ。
///   ただし空文字列 / 空白のみは「未設定」と等価扱いにする。そのまま追記すると
///   先頭の ssh 実行ファイル名が消えて " -o BatchMode=yes" になり ssh が起動できない
///
/// `base` には `gozdGitEnv()` 等の親 env を渡す。新規 dict を返し副作用は持たない。
public func buildNonInteractiveEnv(base: [String: String]) -> [String: String] {
  var env = base
  env["GIT_TERMINAL_PROMPT"] = "0"
  let trimmed = env["GIT_SSH_COMMAND"]?.trimmingCharacters(in: .whitespaces) ?? ""
  let existingSsh = trimmed.isEmpty ? "ssh" : trimmed
  env["GIT_SSH_COMMAND"] = "\(existingSsh) -o BatchMode=yes"
  return env
}

/// 認証 prompt を完全に塞いで git を起動する。HTTPS / SSH のどちらでも背景 fetch が
/// passphrase / username 入力で hang するのを防ぐため、`fetch` 等のリモート操作専用。
func runGitNonInteractive(args: [String], cwd: String) async throws -> Data {
  do {
    return try await runGitNonInteractiveOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  } catch GitError.launchFailed {
    await CommandResolver.shared.invalidate("git")
    return try await runGitNonInteractiveOnce(
      gitPath: try await resolveGitPath(), args: args, cwd: cwd)
  }
}

private func runGitNonInteractiveOnce(gitPath: String, args: [String], cwd: String) async throws
  -> Data
{
  let process = Process()
  process.executableURL = URL(fileURLWithPath: gitPath)
  process.arguments = args
  process.currentDirectoryURL = URL(fileURLWithPath: cwd)
  process.environment = buildNonInteractiveEnv(base: gozdGitEnv())

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
      StderrLog.write(tag: "GitOps", "unparseable hunk header: \(raw)")
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
    StderrLog.write(
      tag: "GitOps", "parseUnifiedDiffHunks: skipped \(unexpectedSkips) unexpected line(s)")
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
