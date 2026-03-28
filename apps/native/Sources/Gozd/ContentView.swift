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
private func resolveProjectDir(from path: String) -> String {
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
    @State private var server: SocketServer?

    /// ワークスペースルート（projectDir 固定 + currentDir 可変）
    let workspaceRoot: WorkspaceRoot

    /// チャンネル（dev / stable のパス分離用）
    private let channel = "dev"

    init(initialPath: String) {
        let projectDir = resolveProjectDir(from: initialPath)
        workspaceRoot = WorkspaceRoot(projectDir: projectDir, currentDir: initialPath)
    }

    var body: some View {
        Group {
            if let page {
                WebView(page)
                    .ignoresSafeArea()
            }
        }
        .onAppear {
            setupApp()
        }
    }

    private func setupApp() {
        // Claude hooks 設定を生成
        let settingsPath = claudeSettingsPath(channel: channel)
        ClaudeHooksGenerator.generate(settingsPath: settingsPath)

        // ソケットサーバーを起動
        let socketServerPath = socketPath(channel: channel)
        let socketServer = SocketServer(socketPath: socketServerPath) { message in
            handleSocketMessage(message)
        }
        socketServer.start()
        server = socketServer

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
        registerRendererHandlers(webPage: webPage, watcher: watcher)
        registerTestHandlers()

        // Vite dev server の URL をロード
        let devServerUrl = URL(string: "http://localhost:5173")!
        webPage.load(URLRequest(url: devServerUrl))
    }

    private func registerPTYHandlers(manager: PTYManager, socketPath: String, settingsPath: String) {
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
        }
    }

    // MARK: - ファイルシステム RPC ハンドラー

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

            let result: [String: Any] = [
                "from": ["content": from.content, "isBinary": from.isBinary, "notFound": from.notFound],
                "to": ["content": to.content, "isBinary": to.isBinary, "notFound": to.notFound],
            ]
            return try JSONSerialization.data(withJSONObject: result)
        }

        bridge.registerRequest("switchDir") { data in
            let params = try JSONDecoder().decode(SwitchDirParams.self, from: data)
            root.switchDir(params.dir)
            // ファイル監視を新しい worktree に張り替え
            let isGitRepo = GitUtils.isGitRepo(dir: params.dir)
            watcher.startWatching(root: params.dir, isGitRepo: isGitRepo)
            let result: [String: String] = [
                "dir": params.dir,
                "fileServerBaseUrl": "gozd-file:/",
            ]
            return try JSONSerialization.data(withJSONObject: result)
        }
    }

    // MARK: - Git RPC ハンドラー（renderer スキーマ準拠: cwd は currentRoot から補完）

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
            return try JSONEncoder().encode(entry)
        }

        bridge.registerRequest("gitWorktreeRemove") { data in
            let params = try JSONDecoder().decode(GitWorktreeRemoveParams.self, from: data)
            try GitWorktree.remove(cwd: getProjDir(), wtPath: params.path, force: params.force ?? false)
            return Data("null".utf8)
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

    // MARK: - 永続化 RPC ハンドラー（renderer スキーマ準拠: projectDir は currentRoot から補完）

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
        let channel = self.channel

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

// MARK: - FS RPC パラメータ型

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

private struct SwitchDirParams: Decodable {
    let dir: String
}

// MARK: - PTY RPC パラメータ型

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

// MARK: - Git RPC パラメータ型（renderer スキーマ準拠: cwd なし）

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

private struct GitWorktreeRemoveParams: Decodable {
    let path: String
    let force: Bool?
}

private struct GitCommitFilesParams: Decodable {
    let hash: String
    let compareHash: String?
}

// MARK: - 永続化 RPC パラメータ型（renderer スキーマ準拠: projectDir なし）

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

// MARK: - Shell 環境変数

/// PTY に注入する環境変数を構築する
///
/// gozd 固有の環境変数（ソケットパス、Claude hooks 設定パス等）を追加する。
/// PTY ID は spawn 後に PTYManager が割り当てるため、ここでは静的な ID を仮設定する。
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

// MARK: - ソケットメッセージ処理

/// ソケット経由で受信したメッセージを処理する
private func handleSocketMessage(_ message: GozdMessage) {
    switch message {
    case .hook(let hookMessage):
        print("[gozd] hook: \(hookMessage.event)")
        // TODO: Phase 3 で ptyId → ウィンドウ特定 → WebView に送信
    case .open(let openMessage):
        print("[gozd] open: \(openMessage.targetPath)")
        // TODO: Phase 3 でウィンドウ管理と連携
    }
}

