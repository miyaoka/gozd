import SwiftUI
import WebKit

struct ContentView: View {
    @State private var bridge = RPCBridge()
    @State private var page: WebPage?
    @State private var ptyManager: PTYManager?
    @State private var fileWatcher: FileWatcher?
    @State private var server: SocketServer?

    /// 現在のワークスペースルート
    @State private var currentRoot: String?

    /// チャンネル（dev / stable のパス分離用）
    private let channel = "dev"

    var body: some View {
        NavigationSplitView {
            SidebarView()
        } detail: {
            if let page {
                WebView(page)
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
        let rootRef = _currentRoot
        let fileSchemeHandler = FileSchemeHandler(rootProvider: {
            MainActor.assumeIsolated { rootRef.wrappedValue }
        })

        var configuration = WebPage.Configuration()
        configuration.urlSchemeHandlers[URLScheme("gozd-rpc")!] = rpcSchemeHandler
        configuration.urlSchemeHandlers[URLScheme("gozd-file")!] = fileSchemeHandler

        let webPage = WebPage(configuration: configuration)
        page = webPage

        // PTY Manager を作成（data/exit を WebView に送信）
        let manager = PTYManager(callbacks: PTYManager.Callbacks(
            onData: { id, bytes in
                // UInt8 バイト列を Base64 エンコードして WebView に送信
                let base64 = Data(bytes).base64EncodedString()
                Task { @MainActor in
                    let js = "window.__gozdReceive?.('ptyData', {id: \(id), data: '\(base64)'})"
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
            onGitStatusChange: {
                Task { @MainActor in
                    let js = "window.__gozdReceive?.('gitStatusChange', {})"
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
        registerGitHandlers()
        registerPersistenceHandlers()
        registerTestHandlers()

        // テスト用 HTML をロード
        webPage.load(html: bridgeTestHTML, baseURL: URL(string: "about:blank")!)
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

    // MARK: - Git RPC ハンドラー

    private func registerGitHandlers() {
        bridge.registerRequest("gitStatus") { data in
            let params = try JSONDecoder().decode(CwdParams.self, from: data)
            let result = GitStatus.getStatus(cwd: params.cwd)
            return try JSONEncoder().encode(result)
        }

        bridge.registerRequest("gitLog") { data in
            let params = try JSONDecoder().decode(GitLogParams.self, from: data)
            let (headCommits, defaultBranchCommits, defaultBranch) = GitLog.getLog(
                cwd: params.cwd,
                maxCount: params.maxCount,
                firstParentOnly: params.firstParentOnly ?? false
            )
            let result = GitLogResult(
                headCommits: headCommits,
                defaultBranchCommits: defaultBranchCommits,
                defaultBranch: defaultBranch
            )
            return try JSONEncoder().encode(result)
        }

        bridge.registerRequest("gitBranchList") { data in
            let params = try JSONDecoder().decode(CwdParams.self, from: data)
            let branches = GitBranch.list(cwd: params.cwd)
            return try JSONEncoder().encode(branches)
        }

        bridge.registerRequest("gitBranchDelete") { data in
            let params = try JSONDecoder().decode(GitBranchDeleteParams.self, from: data)
            try GitBranch.delete(cwd: params.cwd, branch: params.branch)
            return Data("null".utf8)
        }

        bridge.registerRequest("gitWorktreeList") { data in
            let params = try JSONDecoder().decode(CwdParams.self, from: data)
            var entries = GitWorktree.list(cwd: params.cwd)
            GitWorktree.attachGitStatuses(entries: &entries)
            return try JSONEncoder().encode(entries)
        }

        bridge.registerRequest("createWorktree") { data in
            let params = try JSONDecoder().decode(CreateWorktreeParams.self, from: data)
            let entry = try GitWorktree.add(
                cwd: params.cwd,
                worktreeDir: params.worktreeDir,
                branch: params.branch
            )
            return try JSONEncoder().encode(entry)
        }

        bridge.registerRequest("gitWorktreeRemove") { data in
            let params = try JSONDecoder().decode(GitWorktreeRemoveParams.self, from: data)
            try GitWorktree.remove(cwd: params.cwd, wtPath: params.path, force: params.force ?? false)
            return Data("null".utf8)
        }

        bridge.registerRequest("gitCommitFiles") { data in
            let params = try JSONDecoder().decode(GitCommitFilesParams.self, from: data)
            let files = GitDiff.getCommitFiles(
                cwd: params.cwd, hash: params.hash, compareHash: params.compareHash)
            return try JSONEncoder().encode(files)
        }

        bridge.registerRequest("gitDiffRefs") { data in
            let params = try JSONDecoder().decode(GitCommitFilesParams.self, from: data)
            let refs = GitDiff.resolveCommitDiffRefs(
                cwd: params.cwd, hash: params.hash, compareHash: params.compareHash)
            return try JSONEncoder().encode(refs)
        }

        bridge.registerRequest("gitPrList") { data in
            let params = try JSONDecoder().decode(GhParams.self, from: data)
            let prs = GitHubCli.getPrList(cwd: params.cwd, env: params.env ?? [:])
            return try JSONEncoder().encode(prs)
        }

        bridge.registerRequest("gitIssueList") { data in
            let params = try JSONDecoder().decode(GhParams.self, from: data)
            let issues = GitHubCli.getIssueList(cwd: params.cwd, env: params.env ?? [:])
            return try JSONEncoder().encode(issues)
        }

        bridge.registerRequest("gitViewer") { data in
            let params = try JSONDecoder().decode(GhParams.self, from: data)
            let viewer = GitHubCli.getViewer(cwd: params.cwd, env: params.env ?? [:])
            return try JSONEncoder().encode(viewer)
        }
    }

    // MARK: - 永続化 RPC ハンドラー

    private func registerPersistenceHandlers() {
        bridge.registerRequest("configLoad") { _ in
            let config = ConfigPersistence.load()
            return try JSONEncoder().encode(config)
        }

        bridge.registerRequest("configSave") { data in
            let patch = try JSONDecoder().decode(AppConfig.self, from: data)
            ConfigPersistence.save(patch: patch)
            return Data("null".utf8)
        }

        bridge.registerRequest("taskList") { data in
            let params = try JSONDecoder().decode(ProjectDirParams.self, from: data)
            let tasks = TaskPersistence.loadTasks(projectDir: params.projectDir)
            return try JSONEncoder().encode(tasks)
        }

        bridge.registerRequest("taskAdd") { data in
            let params = try JSONDecoder().decode(TaskAddParams.self, from: data)
            let task = try TaskPersistence.addTask(
                projectDir: params.projectDir,
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
                projectDir: params.projectDir, id: params.id, body: params.body)
            return try JSONEncoder().encode(task)
        }

        bridge.registerRequest("taskRemove") { data in
            let params = try JSONDecoder().decode(TaskRemoveParams.self, from: data)
            TaskPersistence.removeTask(projectDir: params.projectDir, id: params.id)
            return Data("null".utf8)
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

// MARK: - Git RPC パラメータ型

private struct CwdParams: Decodable {
    let cwd: String
}

private struct GitLogParams: Decodable {
    let cwd: String
    let maxCount: Int?
    let firstParentOnly: Bool?
}

private struct GitLogResult: Encodable {
    let headCommits: [GitCommit]
    let defaultBranchCommits: [GitCommit]
    let defaultBranch: String?
}

private struct GitBranchDeleteParams: Decodable {
    let cwd: String
    let branch: String
}

private struct CreateWorktreeParams: Decodable {
    let cwd: String
    let worktreeDir: String
    let branch: String
}

private struct GitWorktreeRemoveParams: Decodable {
    let cwd: String
    let path: String
    let force: Bool?
}

private struct GitCommitFilesParams: Decodable {
    let cwd: String
    let hash: String
    let compareHash: String?
}

private struct GhParams: Decodable {
    let cwd: String
    let env: [String: String]?
}

// MARK: - 永続化 RPC パラメータ型

private struct ProjectDirParams: Decodable {
    let projectDir: String
}

private struct TaskAddParams: Decodable {
    let projectDir: String
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
    let projectDir: String
    let id: String
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

// MARK: - Sidebar

struct SidebarView: View {
    var body: some View {
        List {
            Section("Worktrees") {
                Text("main")
                Text("feature/swiftui-migration")
            }
            Section("Tasks") {
                Text("Phase 1: PTY")
            }
        }
        .navigationTitle("gozd")
    }
}

// MARK: - Test HTML

/// RPC + PTY ブリッジの動作確認用 HTML
private let bridgeTestHTML = """
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <style>
            body {
                font-family: -apple-system, system-ui;
                padding: 24px;
                margin: 0;
                background: #1e1e1e;
                color: #e0e0e0;
            }
            h1 { opacity: 0.7; font-size: 18px; }
            .log {
                font-family: ui-monospace, monospace;
                font-size: 13px;
                padding: 12px;
                background: rgba(255,255,255,0.05);
                border-radius: 8px;
                white-space: pre-wrap;
                max-height: 60vh;
                overflow-y: auto;
            }
            button {
                padding: 8px 16px;
                margin: 4px;
                border: 1px solid rgba(255,255,255,0.2);
                border-radius: 6px;
                background: rgba(255,255,255,0.1);
                color: #e0e0e0;
                cursor: pointer;
            }
            button:hover { background: rgba(255,255,255,0.2); }
            .section { margin-top: 16px; }
            input {
                padding: 6px 12px;
                border: 1px solid rgba(255,255,255,0.2);
                border-radius: 6px;
                background: rgba(255,255,255,0.05);
                color: #e0e0e0;
                font-family: ui-monospace, monospace;
                font-size: 13px;
                width: 300px;
            }
        </style>
    </head>
    <body>
        <h1>gozd — RPC + PTY Bridge Test</h1>

        <div class="section">
            <button onclick="testEcho()">Echo</button>
            <button onclick="testPing()">Ping</button>
            <button onclick="testPtySpawn()">PTY Spawn</button>
            <button onclick="testPtyKill()">PTY Kill</button>
        </div>

        <div class="section">
            <input id="ptyInput" placeholder="Type command and press Enter"
                   onkeydown="if(event.key==='Enter') sendPtyInput()" />
        </div>

        <div id="log" class="log"></div>

        <script>
            let currentPtyId = null;

            window.__gozdReceive = (type, payload) => {
                if (type === 'ptyData') {
                    const text = atob(payload.data);
                    log(`[pty:${payload.id}] ${text}`);
                } else if (type === 'ptyExit') {
                    log(`[pty:${payload.id}] exited with code ${payload.exitCode}`);
                    currentPtyId = null;
                } else {
                    log(`[receive] ${type}: ${JSON.stringify(payload)}`);
                }
            };

            async function rpcRequest(name, params = {}) {
                try {
                    const res = await fetch(`gozd-rpc://${name}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(params),
                    });
                    log(`[fetch] ${name} status=${res.status} ok=${res.ok}`);
                    const text = await res.text();
                    log(`[fetch] ${name} body=${text}`);
                    return JSON.parse(text);
                } catch (e) {
                    log(`[fetch-error] ${name}: ${e.message}`);
                    return null;
                }
            }

            // fire-and-forget メッセージ（レスポンス不要）
            function rpcMessage(name, params = {}) {
                fetch(`gozd-rpc://${name}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(params),
                });
            }

            async function testEcho() {
                log("[send] echo");
                const result = await rpcRequest("echo", { hello: "world" });
                log(`[recv] ${JSON.stringify(result)}`);
            }

            async function testPing() {
                log("[send] ping");
                const result = await rpcRequest("ping");
                log(`[recv] ${JSON.stringify(result)}`);
            }

            async function testPtySpawn() {
                if (currentPtyId !== null) {
                    log("[warn] PTY already running");
                    return;
                }
                log("[send] ptySpawn");
                const home = "/Users/" + (await rpcRequest("ping")).timestamp ? "miyaoka" : "user";
                currentPtyId = await rpcRequest("ptySpawn", {
                    dir: "/tmp",
                    cols: 80,
                    rows: 24,
                });
                log(`[recv] ptySpawn: id=${currentPtyId}`);
            }

            function testPtyKill() {
                if (currentPtyId === null) {
                    log("[warn] No PTY running");
                    return;
                }
                log(`[send] ptyKill: id=${currentPtyId}`);
                rpcMessage("ptyKill", { id: currentPtyId });
            }

            function sendPtyInput() {
                const input = document.getElementById("ptyInput");
                if (currentPtyId === null) {
                    log("[warn] No PTY running");
                    return;
                }
                const text = input.value + "\\n";
                rpcMessage("ptyWrite", { id: currentPtyId, data: text });
                input.value = "";
            }

            function log(msg) {
                const el = document.getElementById("log");
                el.textContent += msg + "\\n";
                el.scrollTop = el.scrollHeight;
            }

            log("Bridge ready.");
        </script>
    </body>
    </html>
    """
