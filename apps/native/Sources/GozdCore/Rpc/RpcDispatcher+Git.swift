import Foundation
import GozdProto

// Git ローカル op の RPC handler。`GitOps.*` への薄いラッパー + `CommitInfo` →
// `Gozd_V1_GitCommit` 等の proto 写像を行う。`gh` 経由の GitHub API op は `+GitHub.swift`、
// worktree mutation は `+Worktree.swift` 側に分離。

extension RpcDispatcher {
  func handleGitStatus(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitStatusRequest(jsonUTF8Data: body)
    let status = try await GitOps.gitStatusFull(dir: req.dir)
    var resp = Gozd_V1_GitStatusResponse()
    resp.entries = status.statuses
    resp.renameOldPaths = status.renameOldPaths
    resp.latestMtime = status.latestMtime
    if status.hasUpstream {
      var upstream = Gozd_V1_UpstreamStatus()
      upstream.ahead = status.ahead
      upstream.behind = status.behind
      resp.upstream = upstream
    }
    return try resp.jsonUTF8Data()
  }

  func handleGitWorktreeList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitWorktreeListRequest(jsonUTF8Data: body)
    let worktrees = try await GitOps.worktreeList(dir: req.dir)
    let allTasks = try await tasks.list(dir: req.dir)
    // task ≠ session 設計: terminal close / SessionEnd / clearDeadSession のいずれの
    // 経路でも task は削除されない。filter で UI から消すと永続化に滞留しても削除手段が
    // 失われ、「削除はユーザーの明示操作のみ」という設計と矛盾する。よって全 task を
    // 無条件で出す。「sessionId 空 + ghRef 無し」のような身元なし task もサイドバーに
    // `not-started` として表示され、⋮ メニューの Remove task で片付けられる。
    // 各 wt の git status は補助データ。1 wt の失敗で worktree list 全体を捨てない
    // ため、per-wt で握って空 statuses で続行する。prunable wt は listing から除外
    // 済みなので、ここで失敗するのは worktree 実 path 不整合などの稀ケース。失敗は
    // stderr に残して silent 握り潰しを避ける (主経路に throw は伝播させない)。
    let fullByPath: [String: GitOps.StatusFull] = await withTaskGroup(
      of: (String, GitOps.StatusFull?).self
    ) { group in
      for wt in worktrees {
        let path = wt.path
        group.addTask {
          do {
            let full = try await GitOps.gitStatusFull(dir: path)
            return (path, full)
          } catch {
            StderrLog.write(
              tag: "handleGitWorktreeList",
              "gitStatusFull failed for \(path): \(error)"
            )
            return (path, nil)
          }
        }
      }
      var result: [String: GitOps.StatusFull] = [:]
      for await (path, full) in group {
        if let full { result[path] = full }
      }
      return result
    }
    var resp = Gozd_V1_GitWorktreeListResponse()
    resp.worktrees = worktrees.map { wt in
      var entry = Gozd_V1_WorktreeEntry()
      entry.path = wt.path
      entry.head = wt.head
      entry.branch = wt.branch ?? ""
      entry.isMain = wt.isMain
      let full = fullByPath[wt.path]
      entry.gitStatuses = full?.statuses ?? [:]
      entry.renameOldPaths = full?.renameOldPaths ?? [:]
      entry.latestMtime = full?.latestMtime ?? 0
      if let full, full.hasUpstream {
        var upstream = Gozd_V1_UpstreamStatus()
        upstream.ahead = full.ahead
        upstream.behind = full.behind
        entry.upstream = upstream
      }
      // この worktree に紐づく全 Task を埋める。1 wt = 複数 Claude session の前提で
      // session 単位の Task が複数並ぶ。
      entry.tasks = allTasks.filter { $0.worktreeDir == wt.path }
      return entry
    }
    return try resp.jsonUTF8Data()
  }

  func handleGitLog(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitLogRequest(jsonUTF8Data: body)
    let sortMode: GitOps.LogSortMode = req.sortMode == .date ? .date : .topo
    let result = try await GitOps.log(
      dir: req.dir, maxCount: req.maxCount, firstParentOnly: req.firstParentOnly,
      currentBranchOnly: req.currentBranchOnly, sortMode: sortMode)
    var resp = Gozd_V1_GitLogResponse()
    resp.commits = result.commits.map(toGitCommitProto)
    resp.defaultBranch = result.defaultBranch
    resp.branchHead = result.branchHead
    return try resp.jsonUTF8Data()
  }

  func handleGitDiffHunks(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitDiffHunksRequest(jsonUTF8Data: body)
    let result = try await GitOps.diffHunks(original: req.original, current: req.current)
    var resp = Gozd_V1_GitDiffHunksResponse()
    resp.oldTotalLines = result.oldTotalLines
    resp.newTotalLines = result.newTotalLines
    resp.hunks = result.hunks.map { h in
      var pb = Gozd_V1_DiffHunk()
      pb.oldStart = h.oldStart
      pb.oldLines = h.oldLines
      pb.newStart = h.newStart
      pb.newLines = h.newLines
      pb.lines = h.lines.map { l in
        var pbLine = Gozd_V1_DiffHunkLine()
        pbLine.kind =
          switch l.kind {
          case .context: .context
          case .added: .added
          case .removed: .removed
          }
        pbLine.text = l.text
        return pbLine
      }
      return pb
    }
    return try resp.jsonUTF8Data()
  }

  func handleGitDiffExpandLines(_ body: Data) throws -> Data {
    let req = try Gozd_V1_GitDiffExpandLinesRequest(jsonUTF8Data: body)
    let result = try GitOps.expandDiffLines(
      original: req.original,
      current: req.current,
      oldStart: req.oldStart,
      newStart: req.newStart,
      lines: req.lines
    )
    var resp = Gozd_V1_GitDiffExpandLinesResponse()
    resp.lines = result.map { entry in
      var pb = Gozd_V1_DiffExpandedLine()
      pb.oldLineNo = entry.oldLineNo
      pb.newLineNo = entry.newLineNo
      pb.oldText = entry.oldText
      pb.newText = entry.newText
      return pb
    }
    return try resp.jsonUTF8Data()
  }

  func handleGitShowFile(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitShowFileRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitShowFileResponse()
    resp.result = await fileReadResultFromGit(dir: req.dir, hash: "HEAD", relPath: req.relPath)
    return try resp.jsonUTF8Data()
  }

  func handleGitShowCommitFile(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitShowCommitFileRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitShowCommitFileResponse()
    // 単一コミット選択 (compareHash 空) では GitHub と同等の <hash>^ vs <hash> 比較に揃える。
    // GitOps.commitFiles のファイル一覧と diff endpoint を一致させるため。
    // root commit は <hash>^ が解決失敗 → notFound=true となり追加扱いに自然解決する。
    // 範囲選択 (compareHash 非空) では GitOps.commitFiles の <older>^ vs <newer> に揃え、
    // older 端自身の変更も diff に含める。root commit は `^` 解決失敗 → notFound に倒れる。
    // Working Tree 端の扱いは renderer 側で分岐し、wire には常に実 git hash のみ流れる契約。
    // PR diff モード (base..working) は handleGitPrDiffFiles / handleGitReadBlob を使うため
    // この RPC は流れない。
    let olderEnd = req.compareHash.isEmpty ? req.hash : req.compareHash
    let fromHash = "\(olderEnd)^"
    // content と OID を並行取得。両端の blob OID が一致すれば
    // 「コミット範囲で変更なし」として renderer に伝える（Filer 経由の非変更ファイル選択を救済）。
    async let fromContent = fileReadResultFromGit(
      dir: req.dir, hash: fromHash, relPath: req.relPath)
    async let toContent = fileReadResultFromGit(
      dir: req.dir, hash: req.hash, relPath: req.relPath)
    async let fromOID = GitOps.treeFileOID(
      dir: req.dir, hash: fromHash, relPath: req.relPath)
    async let toOID = GitOps.treeFileOID(
      dir: req.dir, hash: req.hash, relPath: req.relPath)
    let (from, to, fOID, tOID) = await (fromContent, toContent, fromOID, toOID)
    resp.from = from
    resp.to = to
    // 両 OID が解決でき、かつ一致した場合のみ true。proto3 default false 依存にせず明示代入。
    resp.unchanged = fOID != nil && tOID != nil && fOID == tOID
    return try resp.jsonUTF8Data()
  }

  /// `git show <hash>:<path>` の結果を FileReadResult shape にまとめる。
  /// 失敗（exit != 0）= ファイル不在として not_found=true を返す。
  /// 想定する失敗: root commit の `^` 解決失敗、未追跡 path、invalid hash。
  /// それ以外（commandFailed の予期しない exit code 等）は silent drop しないよう
  /// stderr にログを残して dev 環境で観察可能にする。
  func fileReadResultFromGit(dir: String, hash: String, relPath: String) async
    -> Gozd_V1_FileReadResult
  {
    var fr = Gozd_V1_FileReadResult()
    do {
      let data = try await GitOps.showCommitFile(dir: dir, hash: hash, relPath: relPath)
      if data.contains(0x00) {
        fr.isBinary = true
      } else if let text = String(data: data, encoding: .utf8) {
        fr.content = text
      } else {
        fr.isBinary = true
      }
    } catch {
      fr.notFound = true
      StderrLog.write(
        tag: "RpcDispatcher",
        "git show \(hash):\(relPath) failed in \(dir): \(error)"
      )
    }
    return fr
  }

  func handleGitBlameLine(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitBlameLineRequest(jsonUTF8Data: body)
    let info = try await GitOps.blameLine(
      dir: req.dir, relPath: req.relPath, rev: req.rev, line: req.line)
    var resp = Gozd_V1_GitBlameLineResponse()
    var c = Gozd_V1_GitBlameCommit()
    c.hash = info.hash
    c.shortHash = info.shortHash
    c.author = info.author
    c.authorMail = info.authorMail
    c.authorTime = info.authorTime
    c.summary = info.summary
    c.sourceLine = info.sourceLine
    c.notCommitted = info.notCommitted
    resp.commit = c
    return try resp.jsonUTF8Data()
  }

  func handleGitLogLine(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitLogLineRequest(jsonUTF8Data: body)
    let commits = try await GitOps.logLine(
      dir: req.dir, relPath: req.relPath, rev: req.rev, line: req.line, maxCount: req.maxCount)
    var resp = Gozd_V1_GitLogLineResponse()
    resp.commits = commits.map(toGitCommitProto)
    return try resp.jsonUTF8Data()
  }

  func handleGitCommitFiles(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitCommitFilesRequest(jsonUTF8Data: body)
    let compare = req.compareHash.isEmpty ? nil : req.compareHash
    let changes = try await GitOps.commitFiles(
      dir: req.dir, hash: req.hash, compareHash: compare, rangeHashes: req.rangeHashes,
      includeWorkingTree: req.includeWorkingTree)
    var resp = Gozd_V1_GitCommitFilesResponse()
    resp.changes = changes.map(toFileChangeProto)
    return try resp.jsonUTF8Data()
  }

  /// PR diff (3-dot semantics) のファイル一覧。GitOps.prDiffFiles に委譲。
  ///
  /// `req.baseHash` は renderer が `gitMergeBase(HEAD, baseRefOid)` で事前解決した
  /// **merge-base OID** であることが契約 (= GitHub の Files changed と同じ意味論)。
  /// `baseRefOid` を直接渡すと「PR 分岐後に base が前進した分」が逆向きに差分として混入する。
  func handleGitPrDiffFiles(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitPrDiffFilesRequest(jsonUTF8Data: body)
    let changes = try await GitOps.prDiffFiles(dir: req.dir, baseHash: req.baseHash)
    var resp = Gozd_V1_GitPrDiffFilesResponse()
    resp.changes = changes.map(toFileChangeProto)
    return try resp.jsonUTF8Data()
  }

  /// 単一 rev + path の blob 内容。PR diff の base 側 blob 取得など、`gitShowCommitFile` の
  /// 2 endpoint 比較が不要な経路用。失敗 (path 不在 / rev invalid) は notFound=true に倒す。
  /// fileReadResultFromGit のロジックを reuse する。
  ///
  /// rev は `git show <rev>:<path>` に渡るため、`-X<option>` 等の option 注入を弾く
  /// `validateRev` を入口で通す。renderer 信頼境界内とはいえ防御の一貫性のため
  /// (`gitShowCommitFile` / `revReachable` 等の他経路も validateRev を通している)。
  func handleGitReadBlob(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitReadBlobRequest(jsonUTF8Data: body)
    try validateRev(req.hash)
    var resp = Gozd_V1_GitReadBlobResponse()
    resp.result = await fileReadResultFromGit(dir: req.dir, hash: req.hash, relPath: req.relPath)
    return try resp.jsonUTF8Data()
  }

  /// rev (commit OID) が local repo に reachable か。`git cat-file -e <hash>` 相当。
  /// fetch 要求の事前判定に使う。
  func handleGitRevReachable(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitRevReachableRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitRevReachableResponse()
    resp.reachable = await GitOps.revReachable(dir: req.dir, hash: req.hash)
    return try resp.jsonUTF8Data()
  }

  /// `git merge-base <hash1> <hash2>` の結果 (= 最低共通祖先 OID) を返す。
  /// PR diff モードで GitHub の Files changed と同じ 3-dot semantics の左端を解決するのに使う。
  /// 失敗 (unrelated histories / hash 不在) は GitOps.mergeBase が空文字を返すので、本 handler は
  /// それをそのまま wire 値として通す (呼び出し側 `usePrDiffToggleStore.enable()` で空文字判定)。
  func handleGitMergeBase(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitMergeBaseRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitMergeBaseResponse()
    resp.mergeBaseOid = await GitOps.mergeBase(dir: req.dir, hash1: req.hash1, hash2: req.hash2)
    return try resp.jsonUTF8Data()
  }

  func handleGitLsTree(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitLsTreeRequest(jsonUTF8Data: body)
    let entries = try await GitOps.lsTree(dir: req.dir, hash: req.hash, path: req.path)
    var resp = Gozd_V1_GitLsTreeResponse()
    resp.entries = entries.map { entry in
      var e = Gozd_V1_GitTreeEntry()
      e.name = entry.name
      e.type = entry.type
      return e
    }
    return try resp.jsonUTF8Data()
  }

  func handleGitResetMixed(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitResetMixedRequest(jsonUTF8Data: body)
    try await GitOps.resetMixed(dir: req.dir, hash: req.hash)
    return try Gozd_V1_GitResetMixedResponse().jsonUTF8Data()
  }

  func handleGitFetchRemotes(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitFetchRemotesRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitFetchRemotesResponse()
    do {
      try await GitOps.fetchRemotes(dir: req.dir)
      resp.ok = true
    } catch let GitError.commandFailed(_, stderr) {
      // offline / 認証失敗 / remote 未設定 etc. は呼び出し側で握り潰す。
      // stderr 冒頭のみを debug 用に積む (UI には出さない)。
      resp.ok = false
      resp.errorDetail = String(stderr.prefix(512))
    } catch {
      resp.ok = false
      resp.errorDetail = "\(error)"
    }
    return try resp.jsonUTF8Data()
  }

  func handleGitDefaultBranch(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitDefaultBranchRequest(jsonUTF8Data: body)
    // worktree 作成の起点として使う ref を返す。`git worktree add -b <new> <abs> <ref>` の
    // `<ref>` にそのまま渡せる文字列（`origin/main` / `main` 等）が caller の期待値。
    //
    // 1) origin/HEAD 経由で remote default branch を取得（`origin/main` 等を full ref で返す。
    //    既存の `GitOps.defaultBranchName` は git-graph 用途で `origin/` prefix を剥がすため
    //    ここでは流用せず、剥がさない形で扱う）
    // 2) 失敗時は main repo root 自身の current branch に fallback（remote 未設定 / push 前 repo）
    // 3) どちらも引けない（detached HEAD / unborn branch）場合は空文字列を返し、caller が通知 + 中止する
    //
    // `commandFailed`（origin/HEAD 未設定 / detached HEAD 等のドメイン失敗）のみ空文字列に
    // 倒し、`launchFailed`（git CLI 解決失敗）は throw して renderer に通知する。
    let branch: String
    do {
      branch = try await resolveStartPoint(dir: req.dir)
    } catch GitError.commandFailed {
      branch = ""
    }
    var resp = Gozd_V1_GitDefaultBranchResponse()
    resp.branch = branch
    return try resp.jsonUTF8Data()
  }

  func resolveStartPoint(dir: String) async throws -> String {
    // origin/HEAD 未設定（remote 無し / `git remote set-head` 未実行）は `commandFailed`
    // で来るので、それだけ受け流して current branch にフォールバックする。`launchFailed`
    // は rethrow して呼び出し側に伝える。
    do {
      let stdout = try await runGit(
        args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd: dir)
      let text = String(decoding: stdout, as: UTF8.self).trimmingCharacters(
        in: .whitespacesAndNewlines)
      if !text.isEmpty { return text }
    } catch GitError.commandFailed {
      // 次の HEAD fallback に進む
    }
    let stdout = try await runGit(args: ["symbolic-ref", "--short", "HEAD"], cwd: dir)
    return String(decoding: stdout, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
  }

  func handleGitGithubIdentity(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitGithubIdentityRequest(jsonUTF8Data: body)
    // `repoOwnerName` 内部の `runGit` が `GitError.launchFailed` (git CLI 解決失敗 / PATH 不在等)
    // を throw した場合は rethrow して renderer に通知する (silent drop 禁止規律と整合)。
    // `commandFailed` (git config が remote.origin 未設定で exit) は `RepoIdentity.unsetRemote`
    // に倒され、ここでは throw されない。
    //
    // `repoOwnerName` は `gh pr list` 経路と共有することで、git CLI への入力 / parser /
    // host policy をすべて 1 箇所に集約する SSOT 設計。これにより `gh pr list` で PR が拾える
    // repo では必ず `#N` リンクの base も導出できる、という整合性が構造的に保証される。
    var resp = Gozd_V1_GitGithubIdentityResponse()
    switch try await GitHubOps.repoOwnerName(dir: req.dir) {
    case .ok(let owner, let repo):
      resp.owner = owner
      resp.repo = repo
    case .unsetRemote:
      // remote 未設定 (新規 repo / fork なし)。UI には出ないが観察可能にする。
      StderrLog.write(
        tag: "handleGitGithubIdentity", "remote.origin not set for dir=\(req.dir)")
    case .parserRejected:
      // 非 github.com host / 想定外 URL 形式。raw URL は credential 漏出防止のため
      // stderr にも載せない (固定文言 + dir のみで切り分け)。
      StderrLog.write(
        tag: "handleGitGithubIdentity", "unsupported remote URL for dir=\(req.dir)")
    }
    return try resp.jsonUTF8Data()
  }
}

// MARK: - proto mappers (file-private helpers)

/// `CommitInfo` を proto `Gozd_V1_GitCommit` に写す。`/git/log` と `/git/logLine` が同形式の
/// 出力を返すため、写像ロジックを 1 か所に閉じる。
fileprivate func toGitCommitProto(_ c: CommitInfo) -> Gozd_V1_GitCommit {
  var pb = Gozd_V1_GitCommit()
  pb.hash = c.hash
  pb.shortHash = c.shortHash
  pb.parents = c.parents
  pb.author = c.author
  pb.date = c.date
  pb.message = c.message
  pb.body = c.body
  pb.refs = c.refs
  return pb
}

/// `FileChangeInfo` を proto `Gozd_V1_GitFileChange` に写す。`/git/commitFiles` と
/// `/git/prDiffFiles` が同形式の出力を返すため、写像ロジックを 1 か所に閉じる。
fileprivate func toFileChangeProto(_ c: FileChangeInfo) -> Gozd_V1_GitFileChange {
  var pb = Gozd_V1_GitFileChange()
  pb.oldFilePath = c.oldPath
  pb.newFilePath = c.newPath
  pb.type = c.type
  return pb
}
