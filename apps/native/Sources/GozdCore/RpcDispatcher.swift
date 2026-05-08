import AppKit
import Foundation
import GozdProto

// gozd-rpc:// URLSchemeHandler から呼ばれる RPC dispatcher。
//
// 設計判断:
//
// 1. **actor**。PTYRegistry / AppStateStore など共有状態を内包し、
//    複数の URL リクエストが並行してくる WebKit 側からの呼び出しを serial に処理する。
//
// 2. **path 階層**: `/echo` / `/git/status` / `/fs/readFile` / `/pty/spawn` 等。
//    URL でグルーピングが視認しやすい。
//
// 3. **PTY イベントの WebPage push は dispatcher の責務外**。onPtyData / onPtyExit を
//    init で受け取り、PTYRegistry にそのまま渡す。WebPage への callJavaScript wire-up は
//    Phase 3（URLSchemeHandler 統合段階）で URLSchemeHandler 側が実装する。
//
// 4. **戻り値は proto JSON Data**。失敗は throw。URLSchemeHandler 側が HTTP 200 / 4xx / 5xx と
//    `Access-Control-Allow-Origin: *` ヘッダを付ける。
public actor RpcDispatcher {
  public typealias HookHandler = @Sendable (Gozd_V1_HookMessage) -> Void
  public typealias OpenHandler = @Sendable (String) -> Void

  private let pty: PTYRegistry
  private let fsWatch: FSWatchRegistry
  private let appState: AppStateStore
  private let appConfig: AppConfigStore
  private let projectConfig: ProjectConfigStore
  private let tasks: TaskStore
  private let onHook: HookHandler
  private let onOpen: OpenHandler

  public init(
    configDir: String,
    onPtyText: @escaping @Sendable (UInt32, String) -> Void,
    onPtyExit: @escaping @Sendable (UInt32, PTYExitReason) -> Void,
    onHook: @escaping HookHandler = { _ in },
    onOpen: @escaping OpenHandler = { _ in },
    onFsChange: @escaping FSWatchRegistry.FsChangeHandler = { _, _ in },
    onGitStatusChange: @escaping FSWatchRegistry.GitStatusChangeHandler = { _, _ in },
    onBranchChange: @escaping FSWatchRegistry.BranchChangeHandler = { _ in },
    onWorktreeChange: @escaping FSWatchRegistry.WorktreeChangeHandler = { _ in },
    envOverlay: GozdEnvOverlay? = nil,
    pidTracker: PidTracker? = nil
  ) {
    self.pty = PTYRegistry(
      onText: onPtyText, onExit: onPtyExit, envOverlay: envOverlay, pidTracker: pidTracker)
    self.fsWatch = FSWatchRegistry(
      onFsChange: onFsChange,
      onGitStatusChange: onGitStatusChange,
      onBranchChange: onBranchChange,
      onWorktreeChange: onWorktreeChange
    )
    self.appState = AppStateStore(configDir: configDir)
    self.appConfig = AppConfigStore(configDir: configDir)
    self.projectConfig = ProjectConfigStore(configDir: configDir)
    self.tasks = TaskStore(configDir: configDir)
    self.onHook = onHook
    self.onOpen = onOpen
  }

  // MARK: - Inbound (SocketServer NDJSON line)

  /// SocketServer から渡された NDJSON 1 行を ClientMessage としてデコードして適切な
  /// callback に振り分ける。decode 失敗時は SocketDecodeError を throw する。
  ///
  /// 設計判断: gozd-rpc:// 経由の RPC（dispatch）と違いリプライがない fire-and-forget
  /// なので、戻り値も Data ではなく Void。失敗は呼び出し側でログするだけで握りつぶさない。
  public func handleSocketMessage(_ data: Data) throws {
    let msg = try Gozd_V1_ClientMessage(jsonUTF8Data: data)
    guard let body = msg.body else {
      throw SocketDecodeError.emptyOneof
    }
    switch body {
    case .hook(let hook):
      onHook(hook)
    case .open(let open):
      onOpen(open.targetPath)
    }
  }

  public func dispatch(path: String, body: Data) async throws -> Data {
    switch path {
    case "/echo":
      return try await handleEcho(body)
    case "/git/status":
      return try await handleGitStatus(body)
    case "/fs/readFile":
      return try handleFsReadFile(body)
    case "/fs/readDir":
      return try await handleFsReadDir(body)
    case "/fs/watch":
      return try await handleFsWatch(body)
    case "/fs/unwatch":
      return try await handleFsUnwatch(body)
    case "/pty/spawn":
      return try await handlePtySpawn(body)
    case "/pty/write":
      return try await handlePtyWrite(body)
    case "/pty/resize":
      return try await handlePtyResize(body)
    case "/pty/kill":
      return try await handlePtyKill(body)
    case "/appState/load":
      return try handleLoadAppState(body)
    case "/appState/save":
      return try handleSaveAppState(body)
    case "/appConfig/load":
      return try handleLoadAppConfig(body)
    case "/appConfig/save":
      return try handleSaveAppConfig(body)
    case "/open/external":
      return try handleOpenExternal(body)
    case "/open/target":
      return try handleOpenTarget(body)
    case "/open/pickAndOpen":
      return try await handlePickAndOpen(body)
    case "/git/worktreeList":
      return try await handleGitWorktreeList(body)
    case "/git/branchList":
      return try await handleGitBranchList(body)
    case "/git/log":
      return try await handleGitLog(body)
    case "/git/diffFile":
      return try await handleGitDiffFile(body)
    case "/git/showFile":
      return try await handleGitShowFile(body)
    case "/git/showCommitFile":
      return try await handleGitShowCommitFile(body)
    case "/git/commitFiles":
      return try await handleGitCommitFiles(body)
    case "/git/prList":
      return try await handleGitPrList(body)
    case "/git/issueList":
      return try await handleGitIssueList(body)
    case "/git/viewer":
      return try await handleGitViewer(body)
    case "/git/createWorktree":
      return try await handleCreateWorktree(body)
    case "/git/worktreeRemove":
      return try await handleWorktreeRemove(body)
    case "/git/branchDelete":
      return try await handleBranchDelete(body)
    case "/task/list":
      return try await handleTaskList(body)
    case "/task/add":
      return try await handleTaskAdd(body)
    case "/task/update":
      return try await handleTaskUpdate(body)
    case "/task/remove":
      return try await handleTaskRemove(body)
    case "/task/createWorktreeWithTask":
      return try await handleCreateWorktreeWithTask(body)
    case "/fs/readFileAbsolute":
      return try handleFsReadFileAbsolute(body)
    case "/fs/writeFile":
      return try handleFsWriteFile(body)
    case "/fs/stat":
      return try handleFsStat(body)
    case "/projectConfig/load":
      return try handleProjectConfigLoad(body)
    case "/projectConfig/save":
      return try handleProjectConfigSave(body)
    case "/voicevox/launch":
      return try await handleVoicevoxLaunch(body)
    case "/voicevox/checkEngine":
      return try await handleVoicevoxCheckEngine(body)
    case "/voicevox/speak":
      return try await handleVoicevoxSpeak(body)
    case "/window/close":
      return try handleWindowClose(body)
    default:
      throw RpcError.unknownPath(path)
    }
  }

  // MARK: - handlers

  private func handleEcho(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_EchoRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_EchoResponse()
    resp.text = "echo: \(req.text)"
    return try resp.jsonUTF8Data()
  }

  private func handleGitStatus(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitStatusRequest(jsonUTF8Data: body)
    let entries = try await GitOps.gitStatus(dir: req.dir)
    var resp = Gozd_V1_GitStatusResponse()
    resp.entries = entries
    return try resp.jsonUTF8Data()
  }

  private func handleFsReadFile(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsReadFileRequest(jsonUTF8Data: body)
    let info = try FSOps.readFile(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsReadFileResponse()
    resp.content = info.content
    resp.isBinary = info.isBinary
    resp.isDirectory = info.isDirectory
    resp.notFound = info.notFound
    return try resp.jsonUTF8Data()
  }

  private func handleFsReadDir(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_FsReadDirRequest(jsonUTF8Data: body)
    let entries = try await FSOps.readDir(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsReadDirResponse()
    resp.entries = entries.map { entry in
      var e = Gozd_V1_FsReadDirEntry()
      e.name = entry.name
      e.type = entry.type
      e.isIgnored = entry.isIgnored
      return e
    }
    return try resp.jsonUTF8Data()
  }

  private func handleFsWatch(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_FsWatchRequest(jsonUTF8Data: body)
    try await fsWatch.watch(dir: req.dir)
    return try Gozd_V1_FsWatchResponse().jsonUTF8Data()
  }

  private func handleFsUnwatch(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_FsUnwatchRequest(jsonUTF8Data: body)
    await fsWatch.unwatch(dir: req.dir)
    return try Gozd_V1_FsUnwatchResponse().jsonUTF8Data()
  }

  private func handlePtySpawn(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtySpawnRequest(jsonUTF8Data: body)
    let id = try await pty.spawn(
      executable: req.executable,
      args: req.args,
      env: req.env,
      cwd: req.dir,
      rows: UInt16(req.rows),
      cols: UInt16(req.cols)
    )
    var resp = Gozd_V1_PtySpawnResponse()
    resp.ptyID = id
    return try resp.jsonUTF8Data()
  }

  private func handlePtyWrite(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyWriteRequest(jsonUTF8Data: body)
    await pty.write(id: req.ptyID, data: req.data)
    return try Gozd_V1_PtyWriteResponse().jsonUTF8Data()
  }

  private func handlePtyResize(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyResizeRequest(jsonUTF8Data: body)
    await pty.resize(id: req.ptyID, rows: UInt16(req.rows), cols: UInt16(req.cols))
    return try Gozd_V1_PtyResizeResponse().jsonUTF8Data()
  }

  private func handlePtyKill(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_PtyKillRequest(jsonUTF8Data: body)
    await pty.kill(id: req.ptyID)
    return try Gozd_V1_PtyKillResponse().jsonUTF8Data()
  }

  private func handleLoadAppState(_ body: Data) throws -> Data {
    _ = try Gozd_V1_LoadAppStateRequest(jsonUTF8Data: body)
    let state = try appState.load()
    var resp = Gozd_V1_LoadAppStateResponse()
    resp.state = state
    return try resp.jsonUTF8Data()
  }

  private func handleSaveAppState(_ body: Data) throws -> Data {
    let req = try Gozd_V1_SaveAppStateRequest(jsonUTF8Data: body)
    try appState.save(req.state)
    return try Gozd_V1_SaveAppStateResponse().jsonUTF8Data()
  }

  private func handleLoadAppConfig(_ body: Data) throws -> Data {
    _ = try Gozd_V1_LoadAppConfigRequest(jsonUTF8Data: body)
    let config = try appConfig.load()
    var resp = Gozd_V1_LoadAppConfigResponse()
    resp.config = config
    return try resp.jsonUTF8Data()
  }

  private func handleSaveAppConfig(_ body: Data) throws -> Data {
    let req = try Gozd_V1_SaveAppConfigRequest(jsonUTF8Data: body)
    try appConfig.save(req.config)
    return try Gozd_V1_SaveAppConfigResponse().jsonUTF8Data()
  }

  private func handleOpenTarget(_ body: Data) throws -> Data {
    let req = try Gozd_V1_OpenTargetRequest(jsonUTF8Data: body)
    if req.path.isEmpty {
      throw RpcError.invalidArgument("path is empty")
    }
    // SocketServer 経由 OpenMessage と同じ callback に流すことで、
    // CLI（gozd <path>）と renderer 起点の Add directory を同一経路で扱う
    onOpen(req.path)
    return try Gozd_V1_OpenTargetResponse().jsonUTF8Data()
  }

  private func handlePickAndOpen(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_PickAndOpenRequest(jsonUTF8Data: body)
    // NSOpenPanel は @MainActor。actor 内から MainActor.run でホップしてユーザー選択を待つ
    let pickedPath = await MainActor.run {
      let panel = NSOpenPanel()
      panel.canChooseDirectories = true
      panel.canChooseFiles = false
      panel.allowsMultipleSelection = false
      panel.prompt = "Open"
      panel.message = "Select a directory to open"
      let response = panel.runModal()
      if response == .OK, let url = panel.url {
        return url.path
      }
      return ""
    }
    if !pickedPath.isEmpty {
      onOpen(pickedPath)
    }
    return try Gozd_V1_PickAndOpenResponse().jsonUTF8Data()
  }

  private func handleOpenExternal(_ body: Data) throws -> Data {
    let req = try Gozd_V1_OpenExternalRequest(jsonUTF8Data: body)
    guard let url = URL(string: req.url) else {
      throw RpcError.invalidArgument("invalid url: \(req.url)")
    }
    // NSWorkspace.open は @MainActor。actor 内から MainActor.run でホップする。
    Task { @MainActor in
      NSWorkspace.shared.open(url)
    }
    return try Gozd_V1_OpenExternalResponse().jsonUTF8Data()
  }

  // MARK: - git ops

  private func handleGitWorktreeList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitWorktreeListRequest(jsonUTF8Data: body)
    let worktrees = try await GitOps.worktreeList(dir: req.dir)
    let statuses = try await GitOps.gitStatus(dir: req.dir)
    let allTasks = try await tasks.list(dir: req.dir)
    var resp = Gozd_V1_GitWorktreeListResponse()
    resp.worktrees = worktrees.map { wt in
      var entry = Gozd_V1_WorktreeEntry()
      entry.path = wt.path
      entry.head = wt.head
      entry.branch = wt.branch ?? ""
      entry.isMain = wt.isMain
      // active worktree の status のみ返す（旧実装互換）
      if wt.path == req.dir {
        entry.gitStatuses = statuses
      }
      // この worktree に紐づく Task を埋める
      if let task = allTasks.first(where: { $0.worktreeDir == wt.path }) {
        entry.task = task
      }
      return entry
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitBranchList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitBranchListRequest(jsonUTF8Data: body)
    let branches = try await GitOps.branchList(dir: req.dir)
    var resp = Gozd_V1_GitBranchListResponse()
    resp.branches = branches
    return try resp.jsonUTF8Data()
  }

  private func handleGitLog(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitLogRequest(jsonUTF8Data: body)
    let result = try await GitOps.logBoth(
      dir: req.dir, maxCount: req.maxCount, firstParentOnly: req.firstParentOnly)
    func toProto(_ c: CommitInfo) -> Gozd_V1_GitCommit {
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
    var resp = Gozd_V1_GitLogResponse()
    resp.headCommits = result.headCommits.map(toProto)
    resp.defaultBranchCommits = result.defaultBranchCommits.map(toProto)
    resp.defaultBranch = result.defaultBranch
    return try resp.jsonUTF8Data()
  }

  private func handleGitDiffFile(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitDiffFileRequest(jsonUTF8Data: body)
    let diff = try await GitOps.diffFile(dir: req.dir, relPath: req.relPath)
    var resp = Gozd_V1_GitDiffFileResponse()
    resp.diff = diff
    return try resp.jsonUTF8Data()
  }

  private func handleGitShowFile(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitShowFileRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitShowFileResponse()
    resp.result = await fileReadResultFromGit(dir: req.dir, hash: "HEAD", relPath: req.relPath)
    return try resp.jsonUTF8Data()
  }

  private func handleGitShowCommitFile(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitShowCommitFileRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitShowCommitFileResponse()
    if !req.compareHash.isEmpty {
      resp.from = await fileReadResultFromGit(
        dir: req.dir, hash: req.compareHash, relPath: req.relPath)
    } else {
      var notFound = Gozd_V1_FileReadResult()
      notFound.notFound = true
      resp.from = notFound
    }
    resp.to = await fileReadResultFromGit(dir: req.dir, hash: req.hash, relPath: req.relPath)
    return try resp.jsonUTF8Data()
  }

  /// `git show <hash>:<path>` の結果を FileReadResult shape にまとめる。
  /// 失敗（exit != 0）= ファイル不在として not_found=true を返す。
  private func fileReadResultFromGit(dir: String, hash: String, relPath: String) async
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
    }
    return fr
  }

  private func handleGitCommitFiles(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitCommitFilesRequest(jsonUTF8Data: body)
    let compare = req.compareHash.isEmpty ? nil : req.compareHash
    let changes = try await GitOps.commitFiles(
      dir: req.dir, hash: req.hash, compareHash: compare)
    var resp = Gozd_V1_GitCommitFilesResponse()
    resp.changes = changes.map { c in
      var pb = Gozd_V1_GitFileChange()
      pb.oldFilePath = c.oldPath
      pb.newFilePath = c.newPath
      pb.type = c.type
      return pb
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitPrList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitPrListRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitPrListResponse()
    if let prs = await GitHubOps.prList(dir: req.dir) {
      resp.ok = true
      resp.prs = prs.map { p in
        var pb = Gozd_V1_GitPullRequest()
        pb.number = p.number
        pb.title = p.title
        pb.url = p.url
        pb.state = p.state
        pb.author = p.author
        pb.headRef = p.headRef
        pb.baseRef = p.baseRef
        pb.isDraft = p.isDraft
        pb.assignees = p.assignees
        pb.reviewers = p.reviewers
        pb.updatedAt = p.updatedAt
        pb.authorAvatarURL = p.authorAvatarUrl
        return pb
      }
    } else {
      resp.ok = false
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitIssueList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitIssueListRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitIssueListResponse()
    if let issues = await GitHubOps.issueList(dir: req.dir) {
      resp.ok = true
      resp.issues = issues.map { i in
        var pb = Gozd_V1_GitIssue()
        pb.number = i.number
        pb.title = i.title
        pb.url = i.url
        pb.state = i.state
        pb.author = i.author
        pb.labels = i.labels
        pb.assignees = i.assignees
        pb.updatedAt = i.updatedAt
        pb.authorAvatarURL = i.authorAvatarUrl
        return pb
      }
    } else {
      resp.ok = false
    }
    return try resp.jsonUTF8Data()
  }

  private func handleGitViewer(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitViewerRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_GitViewerResponse()
    if let login = await GitHubOps.viewer(dir: req.dir) {
      resp.ok = true
      resp.login = login
    } else {
      resp.ok = false
    }
    return try resp.jsonUTF8Data()
  }

  private func handleCreateWorktree(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_CreateWorktreeRequest(jsonUTF8Data: body)
    let startPoint = req.startPoint.isEmpty ? nil : req.startPoint
    let info = try await WorktreeOps.createWorktree(
      dir: req.dir, worktreeDir: req.worktreeDir, branch: req.branch, startPoint: startPoint)
    var resp = Gozd_V1_CreateWorktreeResponse()
    var entry = Gozd_V1_WorktreeEntry()
    entry.path = info.path
    entry.head = info.head
    entry.branch = info.branch ?? ""
    entry.isMain = info.isMain
    resp.worktree = entry
    resp.dir = info.path
    return try resp.jsonUTF8Data()
  }

  private func handleWorktreeRemove(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitWorktreeRemoveRequest(jsonUTF8Data: body)
    try await WorktreeOps.removeWorktree(dir: req.dir, path: req.path, force: req.force)
    return try Gozd_V1_GitWorktreeRemoveResponse().jsonUTF8Data()
  }

  private func handleBranchDelete(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_GitBranchDeleteRequest(jsonUTF8Data: body)
    try await WorktreeOps.deleteBranch(dir: req.dir, branch: req.branch)
    return try Gozd_V1_GitBranchDeleteResponse().jsonUTF8Data()
  }

  // MARK: - tasks

  private func handleTaskList(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskListRequest(jsonUTF8Data: body)
    let list = try await tasks.list(dir: req.dir)
    var resp = Gozd_V1_TaskListResponse()
    resp.tasks = list
    return try resp.jsonUTF8Data()
  }

  private func handleTaskAdd(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskAddRequest(jsonUTF8Data: body)
    let task = try await tasks.add(
      dir: req.dir, body: req.body, worktreeDir: req.worktreeDir,
      prNumber: req.prNumber, issueNumber: req.issueNumber)
    var resp = Gozd_V1_TaskAddResponse()
    resp.task = task
    return try resp.jsonUTF8Data()
  }

  private func handleTaskUpdate(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskUpdateRequest(jsonUTF8Data: body)
    let task = try await tasks.update(dir: req.dir, id: req.id, body: req.body)
    var resp = Gozd_V1_TaskUpdateResponse()
    resp.task = task
    return try resp.jsonUTF8Data()
  }

  private func handleCreateWorktreeWithTask(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_CreateWorktreeWithTaskRequest(jsonUTF8Data: body)
    let info = try await WorktreeOps.createWorktree(
      dir: req.dir, worktreeDir: req.worktreeDir, branch: req.branch, startPoint: nil)
    let updated = try await tasks.setWorktreeDir(
      dir: req.dir, id: req.id, worktreeDir: info.path)
    var resp = Gozd_V1_CreateWorktreeWithTaskResponse()
    resp.task = updated
    var entry = Gozd_V1_WorktreeEntry()
    entry.path = info.path
    entry.head = info.head
    entry.branch = info.branch ?? ""
    entry.isMain = info.isMain
    entry.task = updated
    resp.worktree = entry
    resp.dir = info.path
    return try resp.jsonUTF8Data()
  }

  private func handleTaskRemove(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_TaskRemoveRequest(jsonUTF8Data: body)
    try await tasks.remove(dir: req.dir, id: req.id)
    return try Gozd_V1_TaskRemoveResponse().jsonUTF8Data()
  }

  // MARK: - fs extra

  private func handleFsReadFileAbsolute(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsReadFileAbsoluteRequest(jsonUTF8Data: body)
    let info = FSOps.readFileAbsolute(absolutePath: req.absolutePath)
    var resp = Gozd_V1_FsReadFileAbsoluteResponse()
    var fr = Gozd_V1_FileReadResult()
    fr.content = info.content
    fr.isBinary = info.isBinary
    fr.isDirectory = info.isDirectory
    fr.notFound = info.notFound
    resp.result = fr
    return try resp.jsonUTF8Data()
  }

  private func handleFsWriteFile(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsWriteFileRequest(jsonUTF8Data: body)
    try FSOps.writeFile(dir: req.dir, path: req.path, data: req.data)
    return try Gozd_V1_FsWriteFileResponse().jsonUTF8Data()
  }

  private func handleFsStat(_ body: Data) throws -> Data {
    let req = try Gozd_V1_FsStatRequest(jsonUTF8Data: body)
    let stat = try FSOps.stat(dir: req.dir, path: req.path)
    var resp = Gozd_V1_FsStatResponse()
    resp.exists = stat.exists
    resp.type = stat.type
    resp.size = stat.size
    resp.modifiedAt = stat.modifiedAt
    return try resp.jsonUTF8Data()
  }

  // MARK: - project config

  private func handleProjectConfigLoad(_ body: Data) throws -> Data {
    let req = try Gozd_V1_ProjectConfigLoadRequest(jsonUTF8Data: body)
    let cfg = try projectConfig.load(dir: req.dir)
    var resp = Gozd_V1_ProjectConfigLoadResponse()
    resp.config = cfg
    return try resp.jsonUTF8Data()
  }

  private func handleProjectConfigSave(_ body: Data) throws -> Data {
    let req = try Gozd_V1_ProjectConfigSaveRequest(jsonUTF8Data: body)
    try projectConfig.save(dir: req.dir, config: req.config)
    return try Gozd_V1_ProjectConfigSaveResponse().jsonUTF8Data()
  }

  // MARK: - voicevox

  private func handleVoicevoxLaunch(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_VoicevoxLaunchRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_VoicevoxLaunchResponse()
    resp.ok = await VoicevoxOps.launch()
    return try resp.jsonUTF8Data()
  }

  private func handleVoicevoxCheckEngine(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_VoicevoxCheckEngineRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_VoicevoxCheckEngineResponse()
    resp.ok = await VoicevoxOps.checkEngine()
    return try resp.jsonUTF8Data()
  }

  private func handleWindowClose(_ body: Data) throws -> Data {
    _ = try Gozd_V1_WindowCloseRequest(jsonUTF8Data: body)
    Task { @MainActor in
      NSApplication.shared.terminate(nil)
    }
    return try Gozd_V1_WindowCloseResponse().jsonUTF8Data()
  }

  private func handleVoicevoxSpeak(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_VoicevoxSpeakRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_VoicevoxSpeakResponse()
    if let wav = await VoicevoxOps.speak(
      text: req.text, speedScale: req.speedScale, volumeScale: req.volumeScale,
      speakerId: req.speakerID)
    {
      resp.wav = wav
    }
    return try resp.jsonUTF8Data()
  }
}

public enum RpcError: Error, Equatable {
  case unknownPath(String)
  case invalidArgument(String)
}

public enum SocketDecodeError: Error, Equatable {
  case emptyOneof
}
