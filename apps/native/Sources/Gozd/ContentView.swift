import SwiftUI
import WebKit

struct ContentView: View {
    @State private var bridge = RPCBridge()
    @State private var page: WebPage?

    var body: some View {
        NavigationSplitView {
            SidebarView()
        } detail: {
            if let page {
                WebView(page)
            }
        }
        .onAppear {
            setupBridge()
        }
    }

    private func setupBridge() {
        // RPC ハンドラー登録（Phase 0 検証用）
        bridge.registerRequest("echo") { data in
            // そのまま返す — ブリッジの動作確認用
            return data
        }

        bridge.registerRequest("ping") { _ in
            let response = ["pong": true, "timestamp": Date().timeIntervalSince1970]
                as [String: Any]
            return try JSONSerialization.data(withJSONObject: response)
        }

        // WebPage をカスタムスキーム付きで作成
        let schemeHandler = RPCSchemeHandler(bridge: bridge)
        var configuration = WebPage.Configuration()
        configuration.urlSchemeHandlers[URLScheme("gozd-rpc")!] = schemeHandler

        let webPage = WebPage(configuration: configuration)
        page = webPage

        // テスト用 HTML をロード
        webPage.load(html: bridgeTestHTML, baseURL: URL(string: "about:blank")!)
    }
}

struct SidebarView: View {
    var body: some View {
        List {
            Section("Worktrees") {
                Text("main")
                Text("feature/swiftui-migration")
            }
            Section("Tasks") {
                Text("Phase 0: Skeleton")
            }
        }
        .navigationTitle("gozd")
    }
}

/// RPC ブリッジの動作確認用 HTML
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
                max-height: 400px;
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
        </style>
    </head>
    <body>
        <h1>gozd — RPC Bridge Test</h1>
        <div>
            <button onclick="testEcho()">Echo Test</button>
            <button onclick="testPing()">Ping Test</button>
        </div>
        <div id="log" class="log"></div>

        <script>
            // Swift → WebView メッセージ受信
            window.__gozdReceive = (type, payload) => {
                log(`[receive] ${type}: ${JSON.stringify(payload)}`);
            };

            // WebView → Swift RPC 呼び出し
            async function rpcRequest(name, params = {}) {
                const res = await fetch(`gozd-rpc://${name}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(params),
                });
                return res.json();
            }

            async function testEcho() {
                log("[send] echo: {hello: 'world'}");
                const result = await rpcRequest("echo", { hello: "world" });
                log(`[recv] echo: ${JSON.stringify(result)}`);
            }

            async function testPing() {
                log("[send] ping");
                const result = await rpcRequest("ping");
                log(`[recv] ping: ${JSON.stringify(result)}`);
            }

            function log(msg) {
                const el = document.getElementById("log");
                el.textContent += msg + "\\n";
                el.scrollTop = el.scrollHeight;
            }

            log("Bridge ready. Click a button to test.");
        </script>
    </body>
    </html>
    """
