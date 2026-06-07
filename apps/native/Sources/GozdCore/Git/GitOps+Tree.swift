import Foundation

// commit / tree / file content 系の RPC op。`git show` / `git ls-tree` / `git diff <hash>^..<hash>`
// (`commitFiles` / `prDiffFiles`) を扱う。root commit を含む range の起点は `emptyTreeHash` を
// 経由して empty tree に倒す (root が追加したファイルも diff に含めるため)。

extension GitOps {
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

  /// PR diff (3-dot semantics): `baseHash` から working tree までの tracked file の name-status 差分を返す。
  ///
  /// 「PR をいま push したら base に何が入るか」のうち **commit 済み + uncommitted (tracked)** を担う
  /// 専用 entry point。
  ///
  /// `baseHash` は renderer が `gitMergeBase(HEAD, baseRefOid)` で事前解決した **merge-base OID**
  /// であることが契約 (= GitHub の Files changed と同じ意味論)。`baseRefOid` を直接渡すと、
  /// PR 分岐後に base ブランチが前進した分が逆向きに差分として混入する (= 「自分のブランチに
  /// 含まれていない main の変更」が PR diff に紛れ込む bug)。本関数自身は与えられた baseHash で
  /// `git diff <baseHash>` を実行するだけで merge-base 計算は内包せず、renderer 側の SSOT
  /// (`usePrDiffToggleStore.lockedBase.diffBaseOid`) が per-file 取得経路 (`gitReadBlob`) とも
  /// 起点を共有できるようにする。
  ///
  /// untracked file の merge は本関数では行わない。renderer 側 (`useChangesStore.fileChanges`) が
  /// `gitStatusStore` 由来の untracked を append する SSOT に一本化したため、untracked を `U` として
  /// 写す責務は renderer の 1 か所に閉じる (range + working-tree 端の経路と同一層に揃える)。
  ///
  /// 実装:
  /// - `git diff --name-status -z --find-renames --diff-filter=AMDR <baseHash>` で merge-base..working
  ///   (右辺省略 = working tree)。rename は `--find-renames` が `R` として解決する。
  public static func prDiffFiles(dir: String, baseHash: String) async throws -> [FileChangeInfo] {
    // baseHash は merge-base OID (renderer 側で解決済み) が契約。`validateRev` は empty を許す
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
}

// MARK: - constants / parsers / helpers

/// git の well-known empty tree object hash。`git hash-object -t tree </dev/null` で
/// 得られる固定値。root commit を range の起点にする際、`<root>` 自身ではなく empty tree
/// を `from` に置くことで root commit が追加したファイルも diff に含まれる。
private let emptyTreeHash = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

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
