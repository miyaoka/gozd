/// WebView を表示し、全 RPC ハンドラーを登録するメインビュー
///
/// ## RPC ハンドラーの実装規約
///
/// RPC スキーマは `packages/rpc/src/index.ts` で定義されている。
/// Swift 側のハンドラーはスキーマの `response` 型と **構造が一致する JSON** を返す必要がある。
///
/// - レスポンスは必ず `Encodable` 型 + `JSONEncoder().encode()` で構築する
///   （`JSONSerialization` + `[String: Any]` は禁止。型安全性がなく `Optional as Any` 問題を招く）
/// - スキーマがラッパーオブジェクト（`{ worktree, dir, fileServerBaseUrl }` 等）を要求する場合、
///   対応する `Encodable` レスポンス型を定義する
/// - `void` レスポンスは `Data("null".utf8)` を返す
///
/// ## cwd の使い分け
///
/// `WorkspaceRoot` が `projectDir`（固定）と `currentDir`（可変）を管理する。
/// - `projectDir`: worktree 一覧、worktree 作成、task、config、PR、issue
/// - `currentDir`: git status、log、diff、ファイル読み取り、switchDir で変化
import SwiftUI
import WebKit

/// スレッドセーフなワークスペースルート管理
///
/// Electrobun 版と同様に projectDir（固定）と currentDir（switchDir で変化）を分離する。
/// - projectDir: task, config, worktreeList, createWorktree, pr, issue で使用
/// - currentDir: git status, log, diff, fsReadDir, fsReadFile 等で使用
final class WorkspaceRoot: @unchecked Sendable {
    /// プロジェクトの main worktree ルート（固定）
    let projectDir: String
    private var _currentDir: String
    private let lock = NSLock()

    /// 現在アクティブな worktree ディレクトリ（switchDir で変化）
    var currentDir: String {
        get { lock.withLock { _currentDir } }
    }

    init(projectDir: String, currentDir: String? = nil) {
        self.projectDir = projectDir
        self._currentDir = currentDir ?? projectDir
    }

    func switchDir(_ dir: String) {
        lock.withLock { _currentDir = dir }
    }
}

/// initialPath から projectDir（main worktree root）を解決する
func resolveProjectDir(from path: String) -> String {
    // git worktree list --porcelain の先頭エントリが main worktree
    let entries = GitWorktree.list(cwd: path)
    if let main = entries.first(where: { $0.isMain }) {
        return main.path
    }
    // git リポジトリでない場合はパスをそのまま使う
    return path
}

struct ContentView: View {
    @State private var bridge = RPCBridge()
    @State private var page: WebPage?
    @State private var ptyManager: PTYManager?
    @State private var fileWatcher: FileWatcher?

    /// ワークスペースルート（projectDir 固定 + currentDir 可変）
    let workspaceRoot: WorkspaceRoot

    /// アプリ全体のコーディネーター
    let coordinator: AppCoordinator

    /// このウィンドウの識別子（SwiftUI の再構築で変わらないよう @State で保持）
    @State private var windowId = UUID().uuidString

    init(initialPath: String, coordinator: AppCoordinator) {
        let projectDir = resolveProjectDir(from: initialPath)
        workspaceRoot = WorkspaceRoot(projectDir: projectDir, currentDir: initialPath)
        self.coordinator = coordinator
    }

    var body: some View {
        Group {
            if let page {
                WebView(page)
                    .ignoresSafeArea()
            } else {
                // page 生成前のプレースホルダ（onAppear / task の確実な発火に必要）
                Color.clear
            }
        }
        .navigationTitle((workspaceRoot.projectDir as NSString).lastPathComponent)
        .task {
            setupApp()
        }
        .onDisappear {
            coordinator.unregisterWindow(id: windowId, projectDir: workspaceRoot.projectDir)
        }
    }

    private func setupApp() {
        // .task の再実行による多重初期化を防止
        print("[ContentView] setupApp called, page=\(page == nil ? "nil" : "exists")")
        guard page == nil else { return }

        let settingsPath = coordinator.claudeSettingsPath
        let socketServerPath = coordinator.socketPath

        // WebPage をカスタムスキーム付きで作成
        let rpcSchemeHandler = RPCSchemeHandler(bridge: bridge)
        let root = workspaceRoot
        let fileSchemeHandler = FileSchemeHandler(rootProvider: {
            root.currentDir
        })

        var configuration = WebPage.Configuration()
        configuration.urlSchemeHandlers[URLScheme("gozd-rpc")!] = rpcSchemeHandler
        configuration.urlSchemeHandlers[URLScheme("gozd-file")!] = fileSchemeHandler

        let webPage = WebPage(configuration: configuration)
        webPage.isInspectable = true
        page = webPage

        // PTY Manager を作成（data/exit を WebView に送信）
        let manager = PTYManager(callbacks: PTYManager.Callbacks(
            onData: { id, bytes in
                // UTF-8 文字列に変換し、JSON エンコードで特殊文字をエスケープ
                let text = String(decoding: Data(bytes), as: UTF8.self)
                guard let jsonData = try? JSONEncoder().encode(text),
                    let jsonStr = String(data: jsonData, encoding: .utf8)
                else { return }
                Task { @MainActor in
                    let js = "window.__gozdReceive?.('ptyData', {id: \(id), data: \(jsonStr)})"
                    _ = try? await webPage.callJavaScript(js)
                }
            },
            onExit: { id, exitCode in
                Task { @MainActor in
                    let js =
                        "window.__gozdReceive?.('ptyExit', {id: \(id), exitCode: \(exitCode)})"
                    _ = try? await webPage.callJavaScript(js)
                }
            }
        ))
        ptyManager = manager

        // FileWatcher を作成（ファイル変更を WebView に通知）
        let watcher = FileWatcher(callbacks: FileWatcher.Callbacks(
            onFsChange: { relDir in
                Task { @MainActor in
                    let escaped = relDir.replacingOccurrences(of: "'", with: "\\'")
                    let js = "window.__gozdReceive?.('fsChange', {relDir: '\(escaped)'})"
                    _ = try? await webPage.callJavaScript(js)
                }
            },
            onGitStatusChange: { [root = workspaceRoot] in
                let dir = root.currentDir
                let status = GitStatus.getStatus(cwd: dir)
                guard let jsonData = try? JSONEncoder().encode(status),
                    let jsonStr = String(data: jsonData, encoding: .utf8)
                else { return }
                Task { @MainActor in
                    let js = "window.__gozdReceive?.('gitStatusChange', \(jsonStr))"
                    _ = try? await webPage.callJavaScript(js)
                }
            },
            onBranchChange: {
                Task { @MainActor in
                    let js = "window.__gozdReceive?.('branchChange', {})"
                    _ = try? await webPage.callJavaScript(js)
                }
            }
        ))
        fileWatcher = watcher

        // RPC ハンドラー登録
        registerPTYHandlers(manager: manager, socketPath: socketServerPath, settingsPath: settingsPath)
        registerFsHandlers(watcher: watcher)
        registerGitHandlers()
        registerPersistenceHandlers()
        registerVoicevoxHandlers()
        registerRendererHandlers(webPage: webPage, watcher: watcher)
        registerTestHandlers()

        // coordinator にウィンドウを登録（hook ルーティング用）
        coordinator.registerWindow(
            id: windowId,
            projectDir: workspaceRoot.projectDir,
            hookHandler: { hookMessage in
                Task { @MainActor in
                    let payload = encodeHookPayload(hookMessage)
                    let js = "window.__gozdReceive?.('gozdHook', \(payload))"
                    _ = try? await webPage.callJavaScript(js)
                }
            }
        )

        // Vite dev server の URL をロード
        let devServerUrl = URL(string: "http://localhost:5173")!
        webPage.load(URLRequest(url: devServerUrl))
    }

    /// PTY 操作の RPC ハンドラー: ptySpawn, ptyWrite, ptyResize, ptyKill
    private func registerPTYHandlers(manager: PTYManager, socketPath: String, settingsPath: String) {
        let coord = coordinator
        let winId = windowId

        bridge.registerRequest("ptySpawn") { data in
            let params = try JSONDecoder().decode(PTYSpawnParams.self, from: data)
            let shellEnv = buildShellEnv(
                socketPath: socketPath,
                settingsPath: settingsPath
            )
            let id = manager.spawn(
                cwd: params.dir,
                cols: params.cols,
                rows: params.rows,
                env: shellEnv
            )
            // PTY ID をこのウィンドウに関連付ける（hook ルーティング用）
            coord.registerPTY(ptyId: id, windowId: winId)
            return try JSONEncoder().encode(id)
        }

        bridge.registerMessage("ptyWrite") { data in
            let params = try JSONDecoder().decode(PTYWriteParams.self, from: data)
            manager.write(id: params.id, data: params.data)
        }

        bridge.registerMessage("ptyResize") { data in
            let params = try JSONDecoder().decode(PTYResizeParams.self, from: data)
            manager.resize(id: params.id, cols: params.cols, rows: params.rows)
        }

        bridge.registerMessage("ptyKill") { data in
            let params = try JSONDecoder().decode(PTYKillParams.self, from: data)
            manager.kill(id: params.id)
            coord.unregisterPTY(ptyId: params.id)
        }
    }

    // MARK: - ファイルシステム RPC ハンドラー

    /// ファイル操作の RPC ハンドラー（cwd: currentDir）
    ///
    /// fsReadDir, fsReadFile, fsReadFileAbsolute, gitShowFile, gitDiffFile,
    /// gitShowCommitFile, switchDir
    private func registerFsHandlers(watcher: FileWatcher) {
        let root = workspaceRoot
        let getDir: @Sendable () -> String = { root.currentDir }

        bridge.registerRequest("fsReadDir") { data in
            let params = try JSONDecoder().decode(FsRelPathParams.self, from: data)
            let dir = getDir()
            guard let resolvedPath = PathValidator.resolveExistingFsPath(root: dir, relPath: params.relPath) else {
                throw RPCError.unknownRequest("Path outside workspace root")
            }

            let fm = FileManager.default
            guard let contents = try? fm.contentsOfDirectory(atPath: resolvedPath) else {
                return try JSONEncoder().encode([] as [FsEntry])
            }

            let visibleEntries = contents.filter { $0 != ".git" }
            let ignored = GitStatus.filterIgnored(entries: visibleEntries, cwd: resolvedPath)

            let entries: [FsEntry] = visibleEntries.map { name in
                let fullPath = (resolvedPath as NSString).appendingPathComponent(name)
                var isDir: ObjCBool = false
                fm.fileExists(atPath: fullPath, isDirectory: &isDir)
                return FsEntry(
                    name: name,
                    isDirectory: isDir.boolValue,
                    isIgnored: ignored.contains(name)
                )
            }

            return try JSONEncoder().encode(entries)
        }

        bridge.registerRequest("fsReadFile") { data in
            let params = try JSONDecoder().decode(FsRelPathParams.self, from: data)
            let dir = getDir()
            guard let resolvedPath = PathValidator.resolveExistingFsPath(root: dir, relPath: params.relPath) else {
                return try JSONEncoder().encode(FileReadResult(content: "", isBinary: false, notFound: true))
            }
            let result = readFileContent(absolutePath: resolvedPath)
            return try JSONEncoder().encode(result)
        }

        bridge.registerRequest("fsReadFileAbsolute") { data in
            let params = try JSONDecoder().decode(FsAbsolutePathParams.self, from: data)
            let result = readFileContent(absolutePath: params.absolutePath)
            return try JSONEncoder().encode(result)
        }

        bridge.registerRequest("gitShowFile") { data in
            let params = try JSONDecoder().decode(FsRelPathParams.self, from: data)
            let dir = getDir()
            guard PathValidator.isInsideRoot(root: dir, relPath: params.relPath) else {
                return try JSONEncoder().encode(FileReadResult(content: "", isBinary: true))
            }

            guard case .success(let stdout) = runGit(args: ["show", "HEAD:\(params.relPath)"], cwd: dir) else {
                return try JSONEncoder().encode(FileReadResult(content: "", isBinary: true))
            }

            // NUL バイトでバイナリ判定
            if let data = stdout.data(using: .utf8), data.contains(0x00) {
                return try JSONEncoder().encode(FileReadResult(content: "", isBinary: true))
            }

            return try JSONEncoder().encode(FileReadResult(content: stdout, isBinary: false))
        }

        bridge.registerRequest("gitDiffFile") { data in
            let params = try JSONDecoder().decode(FsRelPathParams.self, from: data)
            let dir = getDir()
            guard PathValidator.isInsideRoot(root: dir, relPath: params.relPath) else {
                return try JSONEncoder().encode("")
            }

            guard case .success(let stdout) = runGit(args: ["diff", "HEAD", "--", params.relPath], cwd: dir) else {
                return try JSONEncoder().encode("")
            }
            return try JSONEncoder().encode(stdout)
        }

        bridge.registerRequest("gitShowCommitFile") { data in
            let params = try JSONDecoder().decode(GitShowCommitFileParams.self, from: data)
            let dir = getDir()
            guard PathValidator.isInsideRoot(root: dir, relPath: params.relPath) else {
                let empty = FileReadResult(content: "", isBinary: false, notFound: true)
                return try JSONEncoder().encode(["from": empty, "to": empty])
            }

            let refs = GitDiff.resolveCommitDiffRefs(cwd: dir, hash: params.hash, compareHash: params.compareHash)

            func showAtRef(_ ref: String?) -> FileReadResult {
                guard let ref else {
                    return FileReadResult(content: "", isBinary: false, notFound: true)
                }
                guard case .success(let stdout) = runGit(args: ["show", "\(ref):\(params.relPath)"], cwd: dir) else {
                    return FileReadResult(content: "", isBinary: false, notFound: true)
                }
                if let data = stdout.data(using: .utf8), data.contains(0x00) {
                    return FileReadResult(content: "", isBinary: true)
                }
                return FileReadResult(content: stdout, isBinary: false)
            }

            func readWorkingTree() -> FileReadResult {
                guard let resolved = PathValidator.resolveExistingFsPath(root: dir, relPath: params.relPath) else {
                    return FileReadResult(content: "", isBinary: false, notFound: true)
                }
                return readFileContent(absolutePath: resolved)
            }

            let from = showAtRef(refs.from)
            let to = refs.to == nil ? readWorkingTree() : showAtRef(refs.to)

            let response = GitShowCommitFileResponse(from: from, to: to)
            return try JSONEncoder().encode(response)
        }

        bridge.registerRequest("switchDir") { data in
            let params = try JSONDecoder().decode(SwitchDirParams.self, from: data)
            root.switchDir(params.dir)
            // ファイル監視を新しい worktree に張り替え
            let isGitRepo = GitUtils.isGitRepo(dir: params.dir)
            watcher.startWatching(root: params.dir, isGitRepo: isGitRepo)
            let response = SwitchDirResponse(dir: params.dir, fileServerBaseUrl: "gozd-file:/")
            return try JSONEncoder().encode(response)
        }
    }

    // MARK: - Git RPC ハンドラー

    /// Git 操作と worktree 管理の RPC ハンドラー
    ///
    /// cwd が 2 種類ある:
    /// - `getCwd()`（currentDir）: gitStatus, gitLog, gitBranchList, gitCommitFiles, gitDiffRefs
    /// - `getProjDir()`（projectDir）: gitWorktreeList, createWorktree, createWorktreeWithTask,
    ///   gitWorktreeRemove, gitBranchDelete, gitPrList, gitIssueList, gitViewer
    private func registerGitHandlers() {
        let root = workspaceRoot
        // currentDir: git status, log, diff 等の作業ディレクトリ
        let getCwd: @Sendable () -> String = { root.currentDir }
        // projectDir: worktreeList, createWorktree, pr, issue 等のプロジェクトルート
        let getProjDir: @Sendable () -> String = { root.projectDir }

        // renderer スキーマ: gitStatus の response は Record<string, string>（statuses のみ）
        bridge.registerRequest("gitStatus") { _ in
            let result = GitStatus.getStatus(cwd: getCwd())
            return try JSONEncoder().encode(result.statuses)
        }

        bridge.registerRequest("gitLog") { data in
            let params = decodeOrNil(GitLogParams.self, from: data)
            let (headCommits, defaultBranchCommits, defaultBranch) = GitLog.getLog(
                cwd: getCwd(),
                maxCount: params?.maxCount,
                firstParentOnly: params?.firstParentOnly ?? false
            )
            let result = GitLogResult(
                headCommits: headCommits,
                defaultBranchCommits: defaultBranchCommits,
                defaultBranch: defaultBranch
            )
            return try JSONEncoder().encode(result)
        }

        bridge.registerRequest("gitBranchList") { _ in
            let branches = GitBranch.list(cwd: getCwd())
            return try JSONEncoder().encode(branches)
        }

        bridge.registerRequest("gitBranchDelete") { data in
            let params = try JSONDecoder().decode(GitBranchDeleteParams.self, from: data)
            try GitBranch.delete(cwd: getCwd(), branch: params.branch)
            return Data("null".utf8)
        }

        bridge.registerRequest("gitWorktreeList") { _ in
            let projDir = getProjDir()
            var entries = GitWorktree.list(cwd: projDir)
            GitWorktree.attachGitStatuses(entries: &entries)
            // 各 worktree に紐づく Task を付与
            let tasks = TaskPersistence.loadTasks(projectDir: projDir)
            let taskByDir = Dictionary(
                uniqueKeysWithValues: tasks.compactMap { task in
                    task.worktreeDir.map { ($0, task) }
                }
            )
            for i in entries.indices {
                entries[i].task = taskByDir[entries[i].path]
            }
            return try JSONEncoder().encode(entries)
        }

        bridge.registerRequest("createWorktree") { data in
            let params = try JSONDecoder().decode(CreateWorktreeParams.self, from: data)
            let entry = try GitWorktree.add(
                cwd: getProjDir(),
                worktreeDir: params.worktreeDir,
                branch: params.branch
            )
            let response = CreateWorktreeResponse(
                worktree: entry,
                dir: entry.path,
                fileServerBaseUrl: "gozd-file:/"
            )
            return try JSONEncoder().encode(response)
        }

        bridge.registerRequest("gitWorktreeRemove") { data in
            let params = try JSONDecoder().decode(GitWorktreeRemoveParams.self, from: data)
            try GitWorktree.remove(cwd: getProjDir(), wtPath: params.path, force: params.force ?? false)
            return Data("null".utf8)
        }

        bridge.registerRequest("createWorktreeWithTask") { [watcher = self.fileWatcher] data in
            let params = try JSONDecoder().decode(CreateWorktreeWithTaskParams.self, from: data)
            let projDir = getProjDir()

            // プロジェクト設定から symlinks を読み込む
            let config = ProjectConfigPersistence.load(projectDir: projDir)
            let entry = try GitWorktree.add(
                cwd: projDir,
                worktreeDir: params.worktreeDir,
                branch: params.branch,
                symlinks: config.worktreeSymlinks
            )

            // Task を worktree に紐づける
            let task = try TaskPersistence.linkToWorktree(
                projectDir: projDir, id: params.id, worktreeDir: entry.path)

            // worktree エントリに task を付与
            var worktree = entry
            worktree.task = task

            // switchDir 相当: currentDir を更新し FileWatcher を張り替え
            root.switchDir(entry.path)
            let isGitRepo = GitUtils.isGitRepo(dir: entry.path)
            watcher?.startWatching(root: entry.path, isGitRepo: isGitRepo)

            let response = CreateWorktreeWithTaskResponse(
                task: task,
                worktree: worktree,
                dir: worktree.path,
                fileServerBaseUrl: "gozd-file:/"
            )
            return try JSONEncoder().encode(response)
        }

        bridge.registerRequest("gitCommitFiles") { data in
            let params = try JSONDecoder().decode(GitCommitFilesParams.self, from: data)
            let files = GitDiff.getCommitFiles(
                cwd: getCwd(), hash: params.hash, compareHash: params.compareHash)
            return try JSONEncoder().encode(files)
        }

        bridge.registerRequest("gitDiffRefs") { data in
            let params = try JSONDecoder().decode(GitCommitFilesParams.self, from: data)
            let refs = GitDiff.resolveCommitDiffRefs(
                cwd: getCwd(), hash: params.hash, compareHash: params.compareHash)
            return try JSONEncoder().encode(refs)
        }

        bridge.registerRequest("gitPrList") { _ in
            let env = ProcessInfo.processInfo.environment
            let prs = GitHubCli.getPrList(cwd: getProjDir(), env: env)
            return try JSONEncoder().encode(prs)
        }

        bridge.registerRequest("gitIssueList") { _ in
            let env = ProcessInfo.processInfo.environment
            let issues = GitHubCli.getIssueList(cwd: getProjDir(), env: env)
            return try JSONEncoder().encode(issues)
        }

        bridge.registerRequest("gitViewer") { _ in
            let env = ProcessInfo.processInfo.environment
            let viewer = GitHubCli.getViewer(cwd: getProjDir(), env: env)
            return try JSONEncoder().encode(viewer)
        }
    }

    // MARK: - 永続化 RPC ハンドラー

    /// 設定・Task の永続化 RPC ハンドラー（cwd: projectDir）
    ///
    /// configLoad, configSave, projectConfigLoad, projectConfigSave,
    /// taskList, taskAdd, taskUpdate, taskRemove
    private func registerPersistenceHandlers() {
        let root = workspaceRoot
        let getProjectDir: @Sendable () -> String = { root.projectDir }

        bridge.registerRequest("configLoad") { _ in
            let config = ConfigPersistence.load()
            return try JSONEncoder().encode(config)
        }

        bridge.registerRequest("configSave") { data in
            let patch = try JSONDecoder().decode(AppConfig.self, from: data)
            ConfigPersistence.save(patch: patch)
            return Data("null".utf8)
        }

        bridge.registerRequest("projectConfigLoad") { _ in
            let config = ProjectConfigPersistence.load(projectDir: getProjectDir())
            return try JSONEncoder().encode(config)
        }

        bridge.registerRequest("projectConfigSave") { data in
            let patch = try JSONDecoder().decode(ProjectConfig.self, from: data)
            ProjectConfigPersistence.save(projectDir: getProjectDir(), patch: patch)
            return Data("null".utf8)
        }

        bridge.registerRequest("taskList") { _ in
            let tasks = TaskPersistence.loadTasks(projectDir: getProjectDir())
            return try JSONEncoder().encode(tasks)
        }

        bridge.registerRequest("taskAdd") { data in
            let params = try JSONDecoder().decode(TaskAddParams.self, from: data)
            let task = try TaskPersistence.addTask(
                projectDir: getProjectDir(),
                body: params.body,
                worktreeDir: params.worktreeDir,
                prNumber: params.prNumber,
                issueNumber: params.issueNumber
            )
            return try JSONEncoder().encode(task)
        }

        bridge.registerRequest("taskUpdate") { data in
            let params = try JSONDecoder().decode(TaskUpdateParams.self, from: data)
            let task = try TaskPersistence.updateTask(
                projectDir: getProjectDir(), id: params.id, body: params.body)
            return try JSONEncoder().encode(task)
        }

        bridge.registerRequest("taskRemove") { data in
            let params = try JSONDecoder().decode(TaskRemoveParams.self, from: data)
            TaskPersistence.removeTask(projectDir: getProjectDir(), id: params.id)
            return Data("null".utf8)
        }
    }

    // MARK: - Renderer 連携ハンドラー

    private func registerRendererHandlers(webPage: WebPage, watcher: FileWatcher) {
        let root = workspaceRoot
        let channel = coordinator.channel

        // rendererReady: renderer が起動完了した時に gozdOpen を送信
        bridge.registerMessage("rendererReady") { _ in
            Task { @MainActor in
                let dir = root.currentDir
                let isGitRepo = GitUtils.isGitRepo(dir: dir)
                let repoName = (root.projectDir as NSString).lastPathComponent
                let payload = """
                    {dir: '\(dir.replacingOccurrences(of: "'", with: "\\'"))', \
                    fileServerBaseUrl: 'gozd-file:/', \
                    channel: '\(channel)', \
                    repoName: '\(repoName.replacingOccurrences(of: "'", with: "\\'"))', \
                    isGitRepo: \(isGitRepo)}
                    """
                let js = "window.__gozdReceive?.('gozdOpen', \(payload))"
                _ = try? await webPage.callJavaScript(js)

                // ファイル監視を開始
                watcher.startWatching(root: dir, isGitRepo: isGitRepo)
            }
        }

        // openExternal: 外部 URL を開く
        bridge.registerMessage("openExternal") { data in
            guard let params = try? JSONDecoder().decode(OpenExternalParams.self, from: data),
                let url = URL(string: params.url)
            else { return }
            Task { @MainActor in
                NSWorkspace.shared.open(url)
            }
        }

        // windowClose: ウィンドウを閉じる
        bridge.registerMessage("windowClose") { _ in
            Task { @MainActor in
                NSApp.keyWindow?.close()
            }
        }
    }

    // MARK: - VOICEVOX RPC ハンドラー

    /// VOICEVOX 音声合成の RPC ハンドラー: voicevoxCheckEngine, voicevoxLaunch, voicevoxSpeak
    private func registerVoicevoxHandlers() {
        let voicevoxApi = "http://127.0.0.1:50021"

        bridge.registerRequest("voicevoxCheckEngine") { _ in
            let url = URL(string: "\(voicevoxApi)/version")!
            var request = URLRequest(url: url)
            request.timeoutInterval = 3
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                let httpResponse = response as? HTTPURLResponse
                let ok = httpResponse?.statusCode == 200
                return try JSONEncoder().encode(ok)
            } catch {
                return try JSONEncoder().encode(false)
            }
        }

        bridge.registerRequest("voicevoxLaunch") { _ in
            // mdfind で VOICEVOX.app を検索
            let mdfindProcess = Process()
            mdfindProcess.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
            mdfindProcess.arguments = ["kMDItemCFBundleIdentifier == 'jp.hiroshiba.voicevox'"]
            let pipe = Pipe()
            mdfindProcess.standardOutput = pipe
            mdfindProcess.standardError = FileHandle.nullDevice
            do {
                try mdfindProcess.run()
                mdfindProcess.waitUntilExit()
            } catch {
                print("[voicevox] mdfind launch failed: \(error)")
                return try JSONEncoder().encode(false)
            }

            guard mdfindProcess.terminationStatus == 0 else {
                print("[voicevox] mdfind failed (exit \(mdfindProcess.terminationStatus))")
                return try JSONEncoder().encode(false)
            }

            let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            let lines = output.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n")
            guard let appPath = lines.first, !appPath.isEmpty else {
                print("[voicevox] mdfind returned no results")
                return try JSONEncoder().encode(false)
            }

            let enginePath = (appPath as NSString).appendingPathComponent("Contents/Resources/vv-engine/run")
            guard FileManager.default.fileExists(atPath: enginePath) else {
                print("[voicevox] engine not found: \(enginePath)")
                return try JSONEncoder().encode(false)
            }

            // Engine をバックグラウンドで起動（GUI なし）
            let engineProcess = Process()
            engineProcess.executableURL = URL(fileURLWithPath: enginePath)
            engineProcess.standardOutput = FileHandle.nullDevice
            engineProcess.standardError = FileHandle.nullDevice
            do {
                try engineProcess.run()
            } catch {
                print("[voicevox] engine launch failed: \(error)")
                return try JSONEncoder().encode(false)
            }

            // 即座に終了していないか確認（1秒待機）
            try await Task.sleep(for: .seconds(1))
            if !engineProcess.isRunning {
                print("[voicevox] engine exited immediately (code \(engineProcess.terminationStatus))")
                return try JSONEncoder().encode(false)
            }
            return try JSONEncoder().encode(true)
        }

        bridge.registerRequest("voicevoxSpeak") { data in
            let params = try JSONDecoder().decode(VoicevoxSpeakParams.self, from: data)

            // audio_query で音声クエリを生成
            let queryUrlStr =
                "\(voicevoxApi)/audio_query?text=\(params.text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")&speaker=\(params.speakerId)"
            guard let queryUrl = URL(string: queryUrlStr) else {
                return try JSONEncoder().encode(Optional<String>.none)
            }
            var queryRequest = URLRequest(url: queryUrl)
            queryRequest.httpMethod = "POST"
            let (queryData, queryResponse) = try await URLSession.shared.data(for: queryRequest)
            guard let queryHttpResponse = queryResponse as? HTTPURLResponse,
                queryHttpResponse.statusCode == 200
            else {
                return try JSONEncoder().encode(Optional<String>.none)
            }

            // speedScale と volumeScale を設定
            guard var query = try? JSONSerialization.jsonObject(with: queryData) as? [String: Any]
            else {
                return try JSONEncoder().encode(Optional<String>.none)
            }
            query["speedScale"] = params.speedScale
            query["volumeScale"] = params.volumeScale
            let modifiedQueryData = try JSONSerialization.data(withJSONObject: query)

            // synthesis で WAV 音声を合成
            guard let synthesisUrl = URL(string: "\(voicevoxApi)/synthesis?speaker=\(params.speakerId)")
            else {
                return try JSONEncoder().encode(Optional<String>.none)
            }
            var synthesisRequest = URLRequest(url: synthesisUrl)
            synthesisRequest.httpMethod = "POST"
            synthesisRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            synthesisRequest.httpBody = modifiedQueryData
            let (audioData, audioResponse) = try await URLSession.shared.data(for: synthesisRequest)
            guard let audioHttpResponse = audioResponse as? HTTPURLResponse,
                audioHttpResponse.statusCode == 200
            else {
                return try JSONEncoder().encode(Optional<String>.none)
            }

            // base64 エンコードして返す
            let base64 = audioData.base64EncodedString()
            return try JSONEncoder().encode(base64)
        }
    }

    private func registerTestHandlers() {
        bridge.registerRequest("echo") { data in data }

        bridge.registerRequest("ping") { _ in
            let response: [String: Any] = [
                "pong": true,
                "timestamp": Date().timeIntervalSince1970,
            ]
            return try JSONSerialization.data(withJSONObject: response)
        }
    }
}

// MARK: - ヘルパー

/// renderer が params: undefined で呼ぶ RPC のボディ（"null"）をデコード可能にする
private func decodeOrNil<T: Decodable>(_ type: T.Type, from data: Data) -> T? {
    // "null" や空データの場合は nil を返す
    if data.count <= 4, String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespaces) == "null" {
        return nil
    }
    return try? JSONDecoder().decode(type, from: data)
}

// MARK: - RPC パラメータ・レスポンス型
//
// スキーマ定義: packages/rpc/src/index.ts
// 各型はスキーマの params / response に対応する。
// レスポンス型は Encodable 準拠で、JSONEncoder().encode() で返す。

// MARK: FS

private struct FsRelPathParams: Decodable {
    let relPath: String
}

private struct FsAbsolutePathParams: Decodable {
    let absolutePath: String
}

private struct FsEntry: Encodable {
    let name: String
    let isDirectory: Bool
    let isIgnored: Bool
}

private struct GitShowCommitFileParams: Decodable {
    let relPath: String
    let hash: String
    let compareHash: String?
}

private struct GitShowCommitFileResponse: Encodable {
    let from: FileReadResult
    let to: FileReadResult
}

private struct SwitchDirParams: Decodable {
    let dir: String
}

private struct SwitchDirResponse: Encodable {
    let dir: String
    let fileServerBaseUrl: String
}

// MARK: PTY

private struct PTYSpawnParams: Decodable {
    let dir: String
    let cols: Int
    let rows: Int
}

private struct PTYWriteParams: Decodable {
    let id: Int
    let data: String
}

private struct PTYResizeParams: Decodable {
    let id: Int
    let cols: Int
    let rows: Int
}

private struct PTYKillParams: Decodable {
    let id: Int
}

// MARK: Git

private struct GitLogParams: Decodable {
    let maxCount: Int?
    let firstParentOnly: Bool?
}

private struct GitLogResult: Encodable {
    let headCommits: [GitCommit]
    let defaultBranchCommits: [GitCommit]
    let defaultBranch: String?
}

private struct GitBranchDeleteParams: Decodable {
    let branch: String
}

private struct CreateWorktreeParams: Decodable {
    let worktreeDir: String
    let branch: String
}

private struct CreateWorktreeResponse: Encodable {
    let worktree: WorktreeEntry
    let dir: String
    let fileServerBaseUrl: String
}

private struct CreateWorktreeWithTaskParams: Decodable {
    let id: String
    let worktreeDir: String
    let branch: String
}

private struct CreateWorktreeWithTaskResponse: Encodable {
    let task: TaskItem
    let worktree: WorktreeEntry
    let dir: String
    let fileServerBaseUrl: String
}

private struct GitWorktreeRemoveParams: Decodable {
    let path: String
    let force: Bool?
}

private struct GitCommitFilesParams: Decodable {
    let hash: String
    let compareHash: String?
}

// MARK: 永続化

private struct TaskAddParams: Decodable {
    let body: String
    let worktreeDir: String?
    let prNumber: Int?
    let issueNumber: Int?
}

private struct TaskUpdateParams: Decodable {
    let projectDir: String
    let id: String
    let body: String
}

private struct TaskRemoveParams: Decodable {
    let id: String
}

private struct OpenExternalParams: Decodable {
    let url: String
}

// MARK: VOICEVOX

private struct VoicevoxSpeakParams: Decodable {
    let text: String
    let speedScale: Double
    let volumeScale: Double
    let speakerId: Int
}

// MARK: - Shell 環境変数

/// PTY に注入する環境変数を構築する
///
/// gozd 固有の環境変数（ソケットパス、Claude hooks 設定パス等）を追加する。
/// GOZD_PTY_ID は PTYManager.spawn() が自動注入するため、ここでは設定しない。
private func buildShellEnv(socketPath: String, settingsPath: String) -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    // ターミナル環境変数
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["TERM_PROGRAM"] = "gozd"
    env["FORCE_HYPERLINK"] = "1"
    if env["LANG"] == nil {
        env["LANG"] = "en_US.UTF-8"
    }
    // gozd 固有の環境変数
    env["GOZD_SOCKET_PATH"] = socketPath
    env["GOZD_CLAUDE_SETTINGS_PATH"] = settingsPath
    return env
}

// MARK: - Hook ペイロードのエンコード

/// HookMessage を JavaScript に送信可能な JSON 文字列にエンコードする
private func encodeHookPayload(_ hookMessage: HookMessage) -> String {
    var dict: [String: Any] = ["event": hookMessage.event]
    var payload: [String: Any] = [:]
    if let ptyId = hookMessage.payload.ptyId {
        payload["ptyId"] = ptyId
    }
    if let msg = hookMessage.payload.lastAssistantMessage {
        payload["last_assistant_message"] = msg
    }
    if let name = hookMessage.payload.toolName {
        payload["tool_name"] = name
    }
    if let input = hookMessage.payload.toolInput {
        payload["tool_input"] = input
    }
    if let interrupt = hookMessage.payload.isInterrupt {
        payload["is_interrupt"] = interrupt
    }
    dict["payload"] = payload
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let str = String(data: data, encoding: .utf8)
    else {
        return "{}"
    }
    return str
}

