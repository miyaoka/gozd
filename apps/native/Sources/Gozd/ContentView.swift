import SwiftUI
import WebKit

struct ContentView: View {
    @State private var bridge = RPCBridge()
    @State private var page: WebPage?
    @State private var ptyManager: PTYManager?

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
        // WebPage をカスタムスキーム付きで作成
        let schemeHandler = RPCSchemeHandler(bridge: bridge)
        var configuration = WebPage.Configuration()
        configuration.urlSchemeHandlers[URLScheme("gozd-rpc")!] = schemeHandler

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

        // RPC ハンドラー登録
        registerPTYHandlers(manager: manager)
        registerTestHandlers()

        // テスト用 HTML をロード
        webPage.load(html: bridgeTestHTML, baseURL: URL(string: "about:blank")!)
    }

    private func registerPTYHandlers(manager: PTYManager) {
        bridge.registerRequest("ptySpawn") { data in
            let params = try JSONDecoder().decode(PTYSpawnParams.self, from: data)
            let shellEnv = buildShellEnv()
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

// MARK: - Shell 環境変数

/// PTY に注入する環境変数を構築する
private func buildShellEnv() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["TERM_PROGRAM"] = "gozd"
    env["FORCE_HYPERLINK"] = "1"
    if env["LANG"] == nil {
        env["LANG"] = "en_US.UTF-8"
    }
    return env
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
