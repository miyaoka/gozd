import Foundation

// MARK: - プロセス実行ヘルパー

/// コマンドの実行結果
enum ProcessResult: Sendable {
    case success(stdout: String)
    case failure(stderr: String, exitCode: Int32)
}

/// Sendable な Data 格納 box（パイプ読み取り結果の受け渡し用）
private final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func set(_ newValue: Data) { lock.withLock { data = newValue } }
    func get() -> Data { lock.withLock { data } }
}

/// 外部コマンドを実行し、stdout を返す
///
/// stdout と stderr を別キューで並行に readDataToEndOfFile() する。
/// パイプバッファ（64KB）を超える出力でもデッドロックしない。
func runProcess(
    executable: String,
    args: [String],
    cwd: String,
    env: [String: String]? = nil
) -> ProcessResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = args
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)

    if let env {
        process.environment = env
    }

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    do {
        try process.run()
    } catch {
        return .failure(stderr: error.localizedDescription, exitCode: -1)
    }

    // stdout / stderr を別キューで並行 drain（パイプバッファ溢れによるデッドロック防止）
    let stdoutBox = DataBox()
    let stderrBox = DataBox()
    let group = DispatchGroup()

    group.enter()
    DispatchQueue.global(qos: .userInitiated).async {
        stdoutBox.set(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
        group.leave()
    }

    group.enter()
    DispatchQueue.global(qos: .userInitiated).async {
        stderrBox.set(stderrPipe.fileHandleForReading.readDataToEndOfFile())
        group.leave()
    }

    process.waitUntilExit()
    group.wait()

    let stdout = String(data: stdoutBox.get(), encoding: .utf8) ?? ""

    if process.terminationStatus != 0 {
        let stderr = String(data: stderrBox.get(), encoding: .utf8) ?? ""
        return .failure(stderr: stderr.trimmingCharacters(in: .whitespacesAndNewlines), exitCode: process.terminationStatus)
    }

    return .success(stdout: stdout)
}

/// git コマンドを実行する
func runGit(args: [String], cwd: String) -> ProcessResult {
    runProcess(executable: "/usr/bin/git", args: args, cwd: cwd)
}

/// gh コマンドを実行する
func runGh(args: [String], cwd: String, env: [String: String]) -> ProcessResult {
    runProcess(executable: "/usr/bin/gh", args: ["gh"] + args, cwd: cwd, env: env)
}

// MARK: - Git ユーティリティ

enum GitUtils {
    /// git リポジトリ内かどうか判定する
    static func isGitRepo(dir: String) -> Bool {
        if case .success = runGit(args: ["rev-parse", "--is-inside-work-tree"], cwd: dir) {
            return true
        }
        return false
    }

    /// owner/repo 形式のリポジトリ識別子をリモート URL からパースする
    static func parseOwnerRepo(url: String) -> String? {
        // https://github.com/owner/repo.git or git@github.com:owner/repo.git
        let patterns = [
            #"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$"#,
        ]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                let match = regex.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
                let range = Range(match.range(at: 1), in: url)
            else { continue }
            return String(url[range])
        }
        return nil
    }
}

// MARK: - Git Status

/// git status の結果
struct GitStatusResult: Encodable {
    let statuses: [String: String]
    let head: String
    let upstream: UpstreamStatus?
}

struct UpstreamStatus: Encodable {
    let ahead: Int
    let behind: Int
}

enum GitStatus {
    /// git status --porcelain=v2 --branch -z でファイル変更と HEAD ハッシュを取得する
    static func getStatus(cwd: String) -> GitStatusResult {
        let result = runGit(
            args: ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
            cwd: cwd
        )
        guard case .success(let stdout) = result else {
            return GitStatusResult(statuses: [:], head: "", upstream: nil)
        }

        var statuses: [String: String] = [:]
        var head = ""
        var upstream: UpstreamStatus?

        let parts = stdout.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)
        var i = 0

        while i < parts.count {
            let entry = parts[i]
            guard !entry.isEmpty else {
                i += 1
                continue
            }

            // branch ヘッダー行
            if entry.hasPrefix("# branch.oid ") {
                let oid = String(entry.dropFirst("# branch.oid ".count))
                if oid != "(initial)" {
                    head = oid
                }
                i += 1
                continue
            }
            if entry.hasPrefix("# branch.ab ") {
                // "# branch.ab +N -M"
                let ab = String(entry.dropFirst("# branch.ab ".count))
                let parts = ab.split(separator: " ")
                if parts.count == 2,
                    let ahead = Int(parts[0].dropFirst()),  // "+N"
                    let behind = Int(parts[1].dropFirst())  // "-M"
                {
                    upstream = UpstreamStatus(ahead: ahead, behind: behind)
                }
                i += 1
                continue
            }
            if entry.hasPrefix("# ") {
                i += 1
                continue
            }

            // v2 changed entry: "1 XY ..."
            if entry.hasPrefix("1 ") {
                let xy = String(entry[entry.index(entry.startIndex, offsetBy: 2)..<entry.index(entry.startIndex, offsetBy: 4)])
                if let pathStart = nthIndex(of: " ", in: entry, n: 8) {
                    let path = String(entry[entry.index(after: pathStart)...])
                    statuses[path] = xy
                }
                i += 1
                continue
            }

            // v2 unmerged entry: "u XY ..."
            if entry.hasPrefix("u ") {
                let xy = String(entry[entry.index(entry.startIndex, offsetBy: 2)..<entry.index(entry.startIndex, offsetBy: 4)])
                if let pathStart = nthIndex(of: " ", in: entry, n: 10) {
                    let path = String(entry[entry.index(after: pathStart)...])
                    statuses[path] = xy
                }
                i += 1
                continue
            }

            // v2 rename/copy: "2 XY ..." (次の NUL 区切りエントリは origPath)
            if entry.hasPrefix("2 ") {
                let xy = String(entry[entry.index(entry.startIndex, offsetBy: 2)..<entry.index(entry.startIndex, offsetBy: 4)])
                if let pathStart = nthIndex(of: " ", in: entry, n: 9) {
                    let path = String(entry[entry.index(after: pathStart)...])
                    statuses[path] = xy
                }
                i += 2  // origPath をスキップ
                continue
            }

            // untracked: "? <path>"
            if entry.hasPrefix("? ") {
                statuses[String(entry.dropFirst(2))] = "??"
                i += 1
                continue
            }

            // ignored: "! <path>" — スキップ
            i += 1
        }

        return GitStatusResult(statuses: statuses, head: head, upstream: upstream)
    }

    /// git check-ignore で無視されるファイルを判定する
    static func filterIgnored(entries: [String], cwd: String) -> Set<String> {
        guard !entries.isEmpty else { return [] }
        let result = runGit(args: ["check-ignore"] + entries, cwd: cwd)
        guard case .success(let stdout) = result else { return [] }
        return Set(stdout.split(separator: "\n").map(String.init))
    }
}

/// 文字列中の n 番目の指定文字の位置を返す
private func nthIndex(of char: Character, in str: String, n: Int) -> String.Index? {
    var count = 0
    for idx in str.indices {
        if str[idx] == char {
            count += 1
            if count == n { return idx }
        }
    }
    return nil
}

// MARK: - Git Log

/// コミット情報
struct GitCommit: Encodable {
    let hash: String
    let shortHash: String
    let parents: [String]
    let author: String
    let date: Int
    let message: String
    let body: String
    let refs: [String]
}

enum GitLog {
    private static let fieldSeparator = "\u{1F}"  // ASCII Unit Separator
    private static let fieldSeparatorFmt = "%x1f"
    private static let recordSeparator = "\u{1E}"  // ASCII Record Separator
    private static let recordSeparatorFmt = "%x1e"
    private static let defaultMaxCount = 200

    /// HEAD 系統とデフォルトブランチ系統のコミット履歴を取得する
    static func getLog(
        cwd: String, maxCount: Int? = nil, firstParentOnly: Bool = false
    ) -> (headCommits: [GitCommit], defaultBranchCommits: [GitCommit], defaultBranch: String?) {
        let count = min(maxCount ?? defaultMaxCount, defaultMaxCount)
        let format = ["%H", "%P", "%aN", "%at", "%s", "%D", "%b"].joined(separator: fieldSeparatorFmt)

        let defaultBranch = resolveDefaultBranch(cwd: cwd)
        let currentBranch = resolveCurrentBranch(cwd: cwd)

        // HEAD 系統
        var headRefs = ["HEAD"]
        if let currentBranch {
            if let remoteRef = resolveRemoteRef(cwd: cwd, branch: currentBranch) {
                headRefs.append(remoteRef)
            }
        }

        // デフォルトブランチ系統
        var defaultRefs: [String] = []
        if let defaultBranch {
            if localRefExists(cwd: cwd, branch: defaultBranch) {
                defaultRefs.append(defaultBranch)
            }
            if let remoteRef = resolveRemoteRef(cwd: cwd, branch: defaultBranch) {
                defaultRefs.append(remoteRef)
            }
        }

        var baseArgs = [
            "log",
            "--format=\(recordSeparatorFmt)\(format)",
            "--date-order",
            "--max-count=\(count)",
        ]
        if firstParentOnly { baseArgs.append("--first-parent") }

        let headResult = runGit(args: baseArgs + headRefs + ["--"], cwd: cwd)
        let headCommits: [GitCommit]
        if case .success(let stdout) = headResult {
            headCommits = parseGitLog(stdout)
        } else {
            headCommits = []
        }

        var defaultBranchCommits: [GitCommit] = []
        if !defaultRefs.isEmpty {
            let defaultResult = runGit(args: baseArgs + defaultRefs + ["--"], cwd: cwd)
            if case .success(let stdout) = defaultResult {
                defaultBranchCommits = parseGitLog(stdout)
            }
        }

        return (headCommits, defaultBranchCommits, defaultBranch)
    }

    private static func resolveDefaultBranch(cwd: String) -> String? {
        guard case .success(let stdout) = runGit(args: ["symbolic-ref", "refs/remotes/origin/HEAD"], cwd: cwd) else {
            return nil
        }
        let branch = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "refs/remotes/origin/", with: "")
        return branch.isEmpty ? nil : branch
    }

    private static func resolveCurrentBranch(cwd: String) -> String? {
        guard case .success(let stdout) = runGit(args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: cwd) else {
            return nil
        }
        let branch = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        return branch.isEmpty || branch == "HEAD" ? nil : branch
    }

    private static func localRefExists(cwd: String, branch: String) -> Bool {
        if case .success(let stdout) = runGit(args: ["rev-parse", "--verify", "refs/heads/\(branch)"], cwd: cwd) {
            return !stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return false
    }

    private static func resolveRemoteRef(cwd: String, branch: String) -> String? {
        let ref = "origin/\(branch)"
        guard case .success(let stdout) = runGit(args: ["rev-parse", "--verify", "refs/remotes/\(ref)"], cwd: cwd) else {
            return nil
        }
        return stdout.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : ref
    }

    private static func parseGitLog(_ output: String) -> [GitCommit] {
        guard !output.isEmpty else { return [] }

        let records = output.components(separatedBy: recordSeparator).filter { !$0.isEmpty }
        var commits: [GitCommit] = []

        for record in records {
            let fields = record.components(separatedBy: fieldSeparator)
            guard fields.count >= 7 else { continue }

            let hash = fields[0]
            let parentStr = fields[1]
            let author = fields[2]
            let dateStr = fields[3]
            let message = fields[4]
            let refStr = fields[5]

            guard !hash.isEmpty, !author.isEmpty, let date = Int(dateStr) else { continue }

            let parents = parentStr.split(separator: " ").map(String.init).filter { !$0.isEmpty }
            let refs = refStr.isEmpty ? [] : parseRefs(refStr)
            // %b は git が末尾に改行を付与するため除去
            let bodyParts = Array(fields.dropFirst(6))
            let body = bodyParts.joined(separator: fieldSeparator)
                .replacingOccurrences(of: "\\n+$", with: "", options: .regularExpression)

            commits.append(GitCommit(
                hash: hash,
                shortHash: String(hash.prefix(7)),
                parents: parents,
                author: author,
                date: date,
                message: message,
                body: body,
                refs: refs
            ))
        }

        return commits
    }

    /// "HEAD -> main, origin/main, tag: v1.0" をパースする
    private static func parseRefs(_ refStr: String) -> [String] {
        let trimmed = refStr.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return [] }

        var refs: [String] = []
        let parts = trimmed.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }

        for part in parts {
            guard !part.isEmpty else { continue }
            // "HEAD -> main" を "HEAD" と "main" に分解
            if part.hasPrefix("HEAD -> ") {
                refs.append("HEAD")
                refs.append(String(part.dropFirst("HEAD -> ".count)))
            } else if part.hasPrefix("tag: ") {
                refs.append("tag:\(String(part.dropFirst("tag: ".count)))")
            } else {
                refs.append(part)
            }
        }
        return refs
    }
}

// MARK: - Git Diff / Commit Files

/// ファイル変更エントリ
struct GitFileChange: Encodable {
    let oldFilePath: String
    let newFilePath: String
    let type: String  // "A", "M", "D", "R"
}

/// コミット間の from/to リビジョン参照
struct CommitDiffRefs: Encodable {
    let from: String?
    let to: String?
}

/// 未コミット変更を表す特殊ハッシュ
private let uncommittedHash = "0000000000000000000000000000000000000001"

enum GitDiff {
    /// コミットの変更ファイル一覧を取得する
    static func getCommitFiles(cwd: String, hash: String, compareHash: String? = nil) -> [GitFileChange] {
        let args = buildDiffArgs(cwd: cwd, hash: hash, compareHash: compareHash)
        guard case .success(let stdout) = runProcess(executable: "/usr/bin/git", args: Array(args.dropFirst()), cwd: cwd) else {
            return []
        }
        return parseDiffNameStatus(stdout)
    }

    /// コミット間の from/to リビジョン参照を解決する
    static func resolveCommitDiffRefs(cwd: String, hash: String, compareHash: String? = nil) -> CommitDiffRefs {
        if let compareHash {
            let commitA = hash == uncommittedHash ? "HEAD" : hash
            let commitB = compareHash == uncommittedHash ? "HEAD" : compareHash
            let hasUncommitted = hash == uncommittedHash || compareHash == uncommittedHash

            let aIsOlder = isAncestor(cwd: cwd, commitA: commitA, commitB: commitB)
            let older = aIsOlder ? commitA : commitB
            let newer = aIsOlder ? commitB : commitA

            let from = isRootCommit(cwd: cwd, hash: older) ? older : "\(older)^"
            return CommitDiffRefs(from: from, to: hasUncommitted ? nil : newer)
        }

        if isRootCommit(cwd: cwd, hash: hash) {
            return CommitDiffRefs(from: nil, to: hash)
        }
        return CommitDiffRefs(from: "\(hash)^", to: hash)
    }

    private static func isRootCommit(cwd: String, hash: String) -> Bool {
        if case .failure = runGit(args: ["rev-parse", "\(hash)^"], cwd: cwd) {
            return true
        }
        return false
    }

    private static func isAncestor(cwd: String, commitA: String, commitB: String) -> Bool {
        if case .success = runGit(args: ["merge-base", "--is-ancestor", commitA, commitB], cwd: cwd) {
            return true
        }
        return false
    }

    private static func buildDiffArgs(cwd: String, hash: String, compareHash: String?) -> [String] {
        let diffOptions = ["--name-status", "-z", "--find-renames", "--diff-filter=AMDR"]
        let hasUncommitted = hash == uncommittedHash || compareHash == uncommittedHash

        if let compareHash {
            let commitA = hash == uncommittedHash ? "HEAD" : hash
            let commitB = compareHash == uncommittedHash ? "HEAD" : compareHash

            let aIsOlder = isAncestor(cwd: cwd, commitA: commitA, commitB: commitB)
            let older = aIsOlder ? commitA : commitB
            let newer = aIsOlder ? commitB : commitA
            let from = isRootCommit(cwd: cwd, hash: older) ? older : "\(older)^"

            if hasUncommitted {
                return ["git", "diff"] + diffOptions + [from]
            }
            return ["git", "diff"] + diffOptions + [from, newer]
        }

        if isRootCommit(cwd: cwd, hash: hash) {
            return ["git", "diff-tree", "--root", "--no-commit-id", "-r"] + diffOptions + [hash]
        }
        return ["git", "diff"] + diffOptions + ["\(hash)^", hash]
    }

    private static func parseDiffNameStatus(_ stdout: String) -> [GitFileChange] {
        var changes: [GitFileChange] = []
        let parts = stdout.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)
        var i = 0
        while i + 1 < parts.count {
            let status = parts[i]
            guard !status.isEmpty else {
                i += 1
                continue
            }
            let type = String(status.prefix(1))
            if type == "R" {
                guard i + 2 < parts.count else { break }
                let oldFilePath = parts[i + 1]
                let newFilePath = parts[i + 2]
                if !oldFilePath.isEmpty, !newFilePath.isEmpty {
                    changes.append(GitFileChange(oldFilePath: oldFilePath, newFilePath: newFilePath, type: type))
                }
                i += 3
            } else {
                let filePath = parts[i + 1]
                if !filePath.isEmpty {
                    changes.append(GitFileChange(oldFilePath: filePath, newFilePath: filePath, type: type))
                }
                i += 2
            }
        }
        return changes
    }
}

// MARK: - Git Branch

enum GitBranch {
    /// ブランチ名のバリデーション
    static func assertBranchName(_ branch: String) throws {
        let pattern = #"^[\w./-]+$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
            regex.firstMatch(in: branch, range: NSRange(branch.startIndex..., in: branch)) != nil,
            !branch.hasPrefix("-")
        else {
            throw GitError.invalidBranchName(branch)
        }
    }

    /// ブランチ一覧を取得する
    static func list(cwd: String) -> [String] {
        guard case .success(let stdout) = runGit(args: ["branch", "--format=%(refname:short)"], cwd: cwd) else {
            return []
        }
        return stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }

    /// ブランチを削除する
    static func delete(cwd: String, branch: String) throws {
        try assertBranchName(branch)
        let result = runGit(args: ["branch", "-D", "--", branch], cwd: cwd)
        if case .failure(let stderr, _) = result {
            throw GitError.commandFailed("git branch delete failed: \(stderr)")
        }
    }
}

// MARK: - Git Worktree

/// Worktree エントリ
struct WorktreeEntry: Codable {
    let path: String
    let head: String
    var branch: String?
    let isMain: Bool
    var gitStatuses: [String: String]?
    var task: TaskItem?
}

enum GitWorktree {
    /// worktree 一覧を取得する
    static func list(cwd: String) -> [WorktreeEntry] {
        guard case .success(let stdout) = runGit(args: ["worktree", "list", "--porcelain"], cwd: cwd) else {
            return []
        }

        var entries: [WorktreeEntry] = []
        let blocks = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: "\n\n")
        var isFirst = true

        for block in blocks {
            let lines = block.components(separatedBy: "\n")
            var wtPath = ""
            var head = ""
            var branch: String?
            var prunable = false

            for line in lines {
                if line.hasPrefix("worktree ") {
                    wtPath = String(line.dropFirst("worktree ".count))
                } else if line.hasPrefix("HEAD ") {
                    head = String(line.dropFirst("HEAD ".count).prefix(7))
                } else if line.hasPrefix("branch ") {
                    branch = String(line.dropFirst("branch ".count))
                        .replacingOccurrences(of: "refs/heads/", with: "")
                } else if line.hasPrefix("prunable ") {
                    prunable = true
                }
            }

            if !wtPath.isEmpty, !prunable {
                entries.append(WorktreeEntry(path: wtPath, head: head, branch: branch, isMain: isFirst))
            }
            isFirst = false
        }

        return entries
    }

    /// worktree を追加する
    static func add(
        cwd: String, worktreeDir: String, branch: String, symlinks: [String]? = nil
    ) throws -> WorktreeEntry {
        try GitBranch.assertBranchName(branch)

        let worktreeRoot = worktreeBasePath(projectDir: cwd)
        let fm = FileManager.default
        try fm.createDirectory(atPath: worktreeRoot, withIntermediateDirectories: true)

        let wtPath = (worktreeRoot as NSString).appendingPathComponent(worktreeDir)

        // 新規ブランチで worktree 作成を試みる
        let newBranchResult = runGit(args: ["worktree", "add", "-b", branch, wtPath], cwd: cwd)

        if case .failure = newBranchResult {
            // ローカルブランチが存在するか確認
            let branchExists = {
                if case .success = runGit(
                    args: ["show-ref", "--verify", "--quiet", "refs/heads/\(branch)"], cwd: cwd)
                {
                    return true
                }
                return false
            }()

            if branchExists {
                let existingResult = runGit(args: ["worktree", "add", wtPath, branch], cwd: cwd)
                if case .failure(let stderr, _) = existingResult {
                    throw GitError.commandFailed("git worktree add failed: \(stderr)")
                }
            } else {
                // リモートから fetch して worktree 化
                let fetched = try createWorktreeFromRemote(
                    cwd: cwd, branch: branch, wtPath: wtPath)
                if !fetched {
                    if case .failure(let stderr, _) = newBranchResult {
                        throw GitError.commandFailed("git worktree add failed: \(stderr)")
                    }
                }
            }
        }

        // メインリポジトリから指定パスをシンボリックリンク
        if let symlinks, !symlinks.isEmpty {
            createWorktreeSymlinks(mainRepoDir: cwd, wtPath: wtPath, targets: symlinks)
        }

        return WorktreeEntry(path: wtPath, head: "", branch: branch, isMain: false)
    }

    /// メインリポジトリの指定パスを worktree にシンボリックリンクする
    ///
    /// ベストエフォート: パス検証失敗、存在しないソース、既存の dest、symlink 失敗はスキップする。
    private static func createWorktreeSymlinks(
        mainRepoDir: String, wtPath: String, targets: [String]
    ) {
        let fm = FileManager.default
        for target in targets {
            // ソース: realpath で実パスを検証し、リポジトリ外へのトラバーサルを防止
            guard let sourcePath = PathValidator.resolveExistingFsPath(root: mainRepoDir, relPath: target) else {
                continue
            }

            // ネストされたパスに対応するため、親ディレクトリを作成
            let targetDir = (target as NSString).deletingLastPathComponent
            if !targetDir.isEmpty, targetDir != "." {
                guard PathValidator.isInsideRoot(root: wtPath, relPath: targetDir) else { continue }
                let parentPath = (wtPath as NSString).appendingPathComponent(targetDir)
                do {
                    try fm.createDirectory(atPath: parentPath, withIntermediateDirectories: true)
                } catch {
                    continue
                }
                // mkdir で作成されたパスが symlink 経由で worktree 外に出ていないか実パスで検証
                guard PathValidator.resolveExistingFsPath(root: wtPath, relPath: targetDir) != nil else {
                    continue
                }
            }

            // dest: 親ディレクトリの realpath を検証し、worktree 外への書き込みを防止
            guard let destPath = PathValidator.resolveCreatableFsPath(root: wtPath, relPath: target) else {
                continue
            }

            // worktree 側に既に存在する場合はスキップ（git checkout で取得済みの可能性）
            if fm.fileExists(atPath: destPath) {
                continue
            }

            // symlink 作成失敗はスキップ（worktree 自体の作成は成功扱い）
            try? fm.createSymbolicLink(atPath: destPath, withDestinationPath: sourcePath)
        }
    }

    /// worktree を削除する
    static func remove(cwd: String, wtPath: String, force: Bool = false) throws {
        var args = ["worktree", "remove"]
        if force { args.append("--force") }
        args.append(wtPath)

        let result = runGit(args: args, cwd: cwd)
        if case .failure(let stderr, _) = result {
            throw GitError.commandFailed("git worktree remove failed: \(stderr)")
        }
    }

    /// 各 worktree の git status を並列取得して付与する
    static func attachGitStatuses(entries: inout [WorktreeEntry]) {
        for i in entries.indices {
            let status = GitStatus.getStatus(cwd: entries[i].path)
            entries[i].gitStatuses = status.statuses
        }
    }

    private static func createWorktreeFromRemote(cwd: String, branch: String, wtPath: String) throws -> Bool {
        let fetchResult = runGit(args: ["fetch", "origin", branch], cwd: cwd)
        if case .failure = fetchResult { return false }

        let wtResult = runGit(args: ["worktree", "add", "-b", branch, wtPath, "origin/\(branch)"], cwd: cwd)
        if case .failure(let stderr, _) = wtResult {
            throw GitError.commandFailed("git worktree add failed: \(stderr)")
        }
        return true
    }

    /// プロジェクトの worktree 配置ディレクトリを返す
    static func worktreeBasePath(projectDir: String) -> String {
        let home = NSHomeDirectory()
        let base = (home as NSString).appendingPathComponent(".local/share/gozd/worktrees")
        return (base as NSString).appendingPathComponent(ProjectKey.generate(from: projectDir))
    }
}

// MARK: - GitHub CLI (PR / Issue)

/// Pull Request 情報
struct GitPullRequest: Encodable {
    let number: Int
    let title: String
    let url: String
    let headRefName: String
    let state: String
    let isDraft: Bool
    let author: String
    let authorAvatarUrl: String
    let updatedAt: String
    let assignees: [String]
    let reviewers: [String]
}

/// Issue 情報
struct GitIssue: Encodable {
    let number: Int
    let title: String
    let url: String
    let author: String
    let authorAvatarUrl: String
    let updatedAt: String
    let assignees: [String]
}

enum GitHubCli {
    private static let avatarSize = 64

    /// gh コマンドを実行する
    static func execGh(args: [String], cwd: String, env: [String: String]) -> ProcessResult {
        runProcess(executable: "/usr/bin/env", args: ["gh"] + args, cwd: cwd, env: env)
    }

    /// GitHub ログインユーザー名を取得する
    static func getViewer(cwd: String, env: [String: String]) -> String? {
        guard case .success(let stdout) = execGh(args: ["api", "user", "--jq", ".login"], cwd: cwd, env: env) else {
            return nil
        }
        return stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// リポジトリの owner/repo を取得する
    static func getOwnerRepo(cwd: String, env: [String: String]) -> (owner: String, repo: String)? {
        guard case .success(let stdout) = execGh(
            args: ["repo", "view", "--json", "owner,name", "--jq", #".owner.login + "/" + .name"#],
            cwd: cwd, env: env
        ) else { return nil }
        let parts = stdout.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "/")
        guard parts.count == 2 else { return nil }
        return (String(parts[0]), String(parts[1]))
    }

    /// open な PR 一覧を取得する
    static func getPrList(cwd: String, env: [String: String]) -> [GitPullRequest]? {
        guard let ownerRepo = getOwnerRepo(cwd: cwd, env: env) else { return nil }

        let prQuery = """
            query($owner: String!, $repo: String!, $limit: Int!) {
              repository(owner: $owner, name: $repo) {
                owner { login }
                pullRequests(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
                  nodes {
                    number title url headRefName state isDraft
                    author { login avatarUrl(size: \(avatarSize)) }
                    updatedAt
                    headRepository { owner { login } }
                    assignees(first: 20) { nodes { login } }
                    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
                  }
                }
              }
            }
            """

        let prLimit = 100
        let result = execGh(args: [
            "api", "graphql",
            "-F", "owner=\(ownerRepo.owner)",
            "-F", "repo=\(ownerRepo.repo)",
            "-F", "limit=\(prLimit)",
            "-f", "query=\(prQuery)",
        ], cwd: cwd, env: env)

        guard case .success(let stdout) = result,
            let data = stdout.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let dataObj = json["data"] as? [String: Any],
            let repository = dataObj["repository"] as? [String: Any],
            let ownerObj = repository["owner"] as? [String: Any],
            let repoOwnerLogin = ownerObj["login"] as? String,
            let pullRequests = repository["pullRequests"] as? [String: Any],
            let nodes = pullRequests["nodes"] as? [[String: Any]]
        else { return nil }

        return nodes.compactMap { node -> GitPullRequest? in
            guard let number = node["number"] as? Int,
                let title = node["title"] as? String,
                let url = node["url"] as? String,
                let headRefName = node["headRefName"] as? String,
                let state = node["state"] as? String,
                let isDraft = node["isDraft"] as? Bool,
                let updatedAt = node["updatedAt"] as? String
            else { return nil }

            // fork 由来の PR を除外
            if let headRepo = node["headRepository"] as? [String: Any],
                let headOwner = headRepo["owner"] as? [String: Any],
                let headLogin = headOwner["login"] as? String,
                headLogin != repoOwnerLogin
            {
                return nil
            }

            let author = (node["author"] as? [String: Any])?["login"] as? String ?? ""
            let authorAvatarUrl = (node["author"] as? [String: Any])?["avatarUrl"] as? String ?? ""
            let assignees = ((node["assignees"] as? [String: Any])?["nodes"] as? [[String: Any]])?
                .compactMap { $0["login"] as? String } ?? []
            let reviewers = ((node["reviewRequests"] as? [String: Any])?["nodes"] as? [[String: Any]])?
                .compactMap { ($0["requestedReviewer"] as? [String: Any])?["login"] as? String } ?? []

            return GitPullRequest(
                number: number, title: title, url: url, headRefName: headRefName,
                state: state, isDraft: isDraft, author: author, authorAvatarUrl: authorAvatarUrl,
                updatedAt: updatedAt, assignees: assignees, reviewers: reviewers
            )
        }
    }

    /// open な issue 一覧を取得する
    static func getIssueList(cwd: String, env: [String: String]) -> [GitIssue]? {
        guard let ownerRepo = getOwnerRepo(cwd: cwd, env: env) else { return nil }

        let issueQuery = """
            query($owner: String!, $repo: String!, $limit: Int!) {
              repository(owner: $owner, name: $repo) {
                issues(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
                  nodes {
                    number title url
                    author { login avatarUrl(size: \(avatarSize)) }
                    updatedAt
                    assignees(first: 20) { nodes { login } }
                  }
                }
              }
            }
            """

        let issueLimit = 100
        let result = execGh(args: [
            "api", "graphql",
            "-F", "owner=\(ownerRepo.owner)",
            "-F", "repo=\(ownerRepo.repo)",
            "-F", "limit=\(issueLimit)",
            "-f", "query=\(issueQuery)",
        ], cwd: cwd, env: env)

        guard case .success(let stdout) = result,
            let data = stdout.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let dataObj = json["data"] as? [String: Any],
            let repository = dataObj["repository"] as? [String: Any],
            let issues = repository["issues"] as? [String: Any],
            let nodes = issues["nodes"] as? [[String: Any]]
        else { return nil }

        return nodes.compactMap { node -> GitIssue? in
            guard let number = node["number"] as? Int,
                let title = node["title"] as? String,
                let url = node["url"] as? String,
                let updatedAt = node["updatedAt"] as? String
            else { return nil }

            let author = (node["author"] as? [String: Any])?["login"] as? String ?? ""
            let authorAvatarUrl = (node["author"] as? [String: Any])?["avatarUrl"] as? String ?? ""
            let assignees = ((node["assignees"] as? [String: Any])?["nodes"] as? [[String: Any]])?
                .compactMap { $0["login"] as? String } ?? []

            return GitIssue(
                number: number, title: title, url: url,
                author: author, authorAvatarUrl: authorAvatarUrl,
                updatedAt: updatedAt, assignees: assignees
            )
        }
    }
}

// MARK: - エラー型

enum GitError: Error, LocalizedError {
    case invalidBranchName(String)
    case commandFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidBranchName(let name): "Invalid branch name: \(name)"
        case .commandFailed(let msg): msg
        }
    }
}
