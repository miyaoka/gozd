import Foundation
import GozdCore
import GozdProto
import SwiftUI
import WebKit

@main
struct GozdApp: App {
  @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate

  var body: some Scene {
    Window("gozd", id: "main") {
      ContentView()
    }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    setbuf(stdout, nil)
    setbuf(stderr, nil)
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  }
}

struct ContentView: View {
  @State private var runtime = AppRuntime()

  var body: some View {
    WebView(runtime.page)
      .task {
        // dev: $GOZD_DEV_VITE_URL があれば Vite dev server からロード（HMR が効く）。
        // 本番: 埋め込み HTML harness をロード。
        if let viteURL = ProcessInfo.processInfo.environment["GOZD_DEV_VITE_URL"],
          let url = URL(string: viteURL)
        {
          do {
            for try await _ in runtime.page.load(url) {}
          } catch {
            print("page.load (vite) failed: \(error)")
          }
        } else {
          let html = ptyHarnessHTML(socketPath: runtime.socketPath)
          do {
            for try await _ in runtime.page.load(
              html: html,
              baseURL: URL(string: "gozd-app://localhost/")!
            ) {}
          } catch {
            print("page.load (harness) failed: \(error)")
          }
        }
      }
  }
}

// アプリの runtime 状態。WebPage と SocketServer を 1 つのオブジェクトで束ねる。
//
// 設計判断: @State<class> は SwiftUI 側の更新には乗らないが、ここでは
// 「init で作って後はそのまま」なので問題ない。SocketServer はバックグラウンド
// queue で listen し続けるため、AppRuntime の生存期間がそれを保証する。
@MainActor
final class AppRuntime {
  let page: WebPage
  let server: SocketServer
  let socketPath: String

  init() {
    let socketPath = AppRuntime.defaultSocketPath()
    self.socketPath = socketPath
    let holder = WebPageHolder()

    // WebPage push 用 callback。background queue から呼ばれるため Task @MainActor で hop。
    let onPtyText: @Sendable (UInt32, String) -> Void = { id, text in
      Task { @MainActor in
        _ = try? await holder.page?.callJavaScript(
          "window.__gozdReceive(type, payload)",
          arguments: [
            "type": "ptyText",
            "payload": ["id": Int(id), "text": text],
          ]
        )
      }
    }
    let onPtyExit: @Sendable (UInt32, PTYExitReason) -> Void = { id, reason in
      let reasonPayload = encodeExitReason(reason)
      Task { @MainActor in
        _ = try? await holder.page?.callJavaScript(
          "window.__gozdReceive(type, payload)",
          arguments: [
            "type": "ptyExit",
            "payload": ["id": Int(id), "reason": reasonPayload],
          ]
        )
      }
    }
    let onHook: @Sendable (Gozd_V1_HookMessage) -> Void = { hook in
      let payload: [String: Any] = [
        "event": hook.event,
        "ptyId": Int(hook.ptyID),
        "lastAssistantMessage": hook.lastAssistantMessage,
        "toolName": hook.toolName,
        "toolInput": hook.toolInput,
        "isInterrupt": hook.isInterrupt,
      ]
      Task { @MainActor in
        _ = try? await holder.page?.callJavaScript(
          "window.__gozdReceive(type, payload)",
          arguments: ["type": "hook", "payload": payload]
        )
      }
    }
    let channel = AppRuntime.channelFromSocketPath(socketPath)
    let onOpen: @Sendable (String) -> Void = { targetPath in
      Task { @MainActor in
        let payload = await AppRuntime.buildGozdOpenPayload(
          targetPath: targetPath, channel: channel)
        _ = try? await holder.page?.callJavaScript(
          "window.__gozdReceive(type, payload)",
          arguments: ["type": "gozdOpen", "payload": payload]
        )
      }
    }

    let onFsChange: FSWatchRegistry.FsChangeHandler = { dir, relDir in
      Task { @MainActor in
        _ = try? await holder.page?.callJavaScript(
          "window.__gozdReceive(type, payload)",
          arguments: [
            "type": "fsChange",
            "payload": ["dir": dir, "relDir": relDir],
          ]
        )
      }
    }
    let onGitStatusChange: FSWatchRegistry.GitStatusChangeHandler = { dir, status in
      let payload: [String: Any] = [
        "dir": dir,
        "statuses": status.statuses,
        "head": status.head,
        "hasUpstream": status.hasUpstream,
        "ahead": Int(status.ahead),
        "behind": Int(status.behind),
      ]
      Task { @MainActor in
        _ = try? await holder.page?.callJavaScript(
          "window.__gozdReceive(type, payload)",
          arguments: ["type": "gitStatusChange", "payload": payload]
        )
      }
    }
    let onBranchChange: FSWatchRegistry.BranchChangeHandler = { dir in
      Task { @MainActor in
        _ = try? await holder.page?.callJavaScript(
          "window.__gozdReceive(type, payload)",
          arguments: ["type": "branchChange", "payload": ["dir": dir]]
        )
      }
    }
    let onWorktreeChange: FSWatchRegistry.WorktreeChangeHandler = { dir in
      Task { @MainActor in
        _ = try? await holder.page?.callJavaScript(
          "window.__gozdReceive(type, payload)",
          arguments: ["type": "worktreeChange", "payload": ["dir": dir]]
        )
      }
    }

    let dispatcher = RpcDispatcher(
      configDir: AppRuntime.defaultConfigDir(),
      onPtyText: onPtyText,
      onPtyExit: onPtyExit,
      onHook: onHook,
      onOpen: onOpen,
      onFsChange: onFsChange,
      onGitStatusChange: onGitStatusChange,
      onBranchChange: onBranchChange,
      onWorktreeChange: onWorktreeChange
    )

    var config = WebPage.Configuration()
    config.urlSchemeHandlers[URLScheme("gozd-rpc")!] = RpcSchemeHandler(dispatcher: dispatcher)
    let page = WebPage(configuration: config)
    page.isInspectable = true
    holder.page = page
    self.page = page

    // SocketServer 起動。受信した NDJSON 行を dispatcher に流す。
    // decode 失敗（不正 JSON / oneof 未指定）は stderr にログするだけで
    // 接続は維持する（CLI 側のバグで server が落ちないように）。
    let server = SocketServer(socketPath: socketPath)
    self.server = server
    do {
      try server.start { line in
        Task {
          do {
            try await dispatcher.handleSocketMessage(line)
          } catch {
            FileHandle.standardError.write(
              Data("[SocketServer] decode failed: \(error)\n".utf8)
            )
          }
        }
      }
      print("[SocketServer] listening on \(socketPath)")
    } catch {
      print("[SocketServer] start failed: \(error)")
    }
  }

  deinit {
    // SocketServer は deinit で listener.cancel() + unlink するので明示は不要。
  }

  private static func defaultConfigDir() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home.appendingPathComponent(".config/gozd").path
  }

  private static func defaultSocketPath() -> String {
    // architecture.md の規約: $TMPDIR/gozd-{channel}.sock。`swift run` 時は dev 扱い。
    let tmp = NSTemporaryDirectory()
    return (tmp as NSString).appendingPathComponent("gozd-dev.sock")
  }

  /// `/tmp/gozd-dev.sock` → `dev` のように socket basename からチャネル名を抽出。
  /// 規約: `gozd-{channel}.sock`。マッチしない場合は空文字列を返し、renderer 側で
  /// channel が空のままになる（appStore.setChannel が no-op）。
  fileprivate static func channelFromSocketPath(_ path: String) -> String {
    let base = (path as NSString).lastPathComponent
    guard base.hasPrefix("gozd-"), base.hasSuffix(".sock") else { return "" }
    let start = base.index(base.startIndex, offsetBy: "gozd-".count)
    let end = base.index(base.endIndex, offsetBy: -".sock".count)
    return String(base[start..<end])
  }

  /// OpenMessage.targetPath を gozdOpen event payload に変換する。
  /// - git repo 内のパスなら `git rev-parse --show-toplevel` で repo root を解決し、
  ///   そのディレクトリ名を repoName として使う。
  /// - git 管理外のパスなら targetPath をそのまま dir として使い、isGitRepo=false。
  /// - file 指定（targetPath が file）の場合、selection を埋めて dir は parent にする。
  fileprivate static func buildGozdOpenPayload(
    targetPath: String, channel: String
  ) async -> [String: Any] {
    let fm = FileManager.default
    var isDir: ObjCBool = false
    let exists = fm.fileExists(atPath: targetPath, isDirectory: &isDir)

    let probeDir: String
    var selection: [String: Any] = [:]
    if exists, !isDir.boolValue {
      // ファイル指定 → parent を dir にして selection を埋める
      let parent = (targetPath as NSString).deletingLastPathComponent
      probeDir = parent
      selection = [
        "kind": "file",
        "relPath": (targetPath as NSString).lastPathComponent,
        "lineNumber": 0,
      ]
    } else {
      probeDir = targetPath
    }

    var dir = probeDir
    var repoName = (probeDir as NSString).lastPathComponent
    var isGitRepo = false
    if let toplevel = try? await GitOps.repoTopLevel(dir: probeDir), !toplevel.isEmpty {
      dir = toplevel
      repoName = (toplevel as NSString).lastPathComponent
      isGitRepo = true
      // file 指定で probeDir が toplevel と異なる場合、selection.relPath を toplevel
      // からの相対パスに更新する
      if !selection.isEmpty, probeDir != toplevel {
        let absFile = (probeDir as NSString).appendingPathComponent(
          selection["relPath"] as? String ?? "")
        if absFile.hasPrefix(toplevel) {
          let rel = String(absFile.dropFirst(toplevel.count))
          selection["relPath"] = rel.hasPrefix("/") ? String(rel.dropFirst()) : rel
        }
      }
    }

    var payload: [String: Any] = [
      "dir": dir,
      "channel": channel,
      "repoName": repoName,
      "isGitRepo": isGitRepo,
      "switchToDir": "",
    ]
    if !selection.isEmpty {
      payload["selection"] = selection
    }
    return payload
  }
}

// WebPage は @MainActor。dispatcher の callback は background queue から呼ばれるため、
// 弱参照を保持する @MainActor クラスで包んで Task hop で push する。
@MainActor
final class WebPageHolder {
  weak var page: WebPage?
}

private func encodeExitReason(_ reason: PTYExitReason) -> [String: Any] {
  switch reason {
  case .exited(let code):
    return ["kind": "exited", "exitCode": Int(code)]
  case .signaled(let signal, let coreDumped):
    return ["kind": "signaled", "signal": Int(signal), "coreDumped": coreDumped]
  case .stopped:
    return ["kind": "stopped"]
  }
}

// HTTP-style 包装を担当する URLSchemeHandler。実際の RPC ロジックは RpcDispatcher。
struct RpcSchemeHandler: URLSchemeHandler {
  let dispatcher: RpcDispatcher

  func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
    AsyncThrowingStream { continuation in
      Task {
        guard let url = request.url else {
          continuation.finish(throwing: SchemeError.missingURL)
          return
        }
        let body = request.httpBody ?? Data()

        do {
          let respData = try await dispatcher.dispatch(path: url.path, body: body)
          let httpResp = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            ]
          )!
          continuation.yield(.response(httpResp))
          continuation.yield(.data(respData))
        } catch RpcError.unknownPath(let p) {
          yield(continuation: continuation, status: 404, url: url, message: "unknown RPC: \(p)")
        } catch {
          yield(continuation: continuation, status: 500, url: url, message: "\(error)")
        }
        continuation.finish()
      }
    }
  }

  private func yield(
    continuation: AsyncThrowingStream<URLSchemeTaskResult, any Error>.Continuation,
    status: Int,
    url: URL,
    message: String
  ) {
    let httpResp = HTTPURLResponse(
      url: url,
      statusCode: status,
      httpVersion: "HTTP/1.1",
      headerFields: [
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      ]
    )!
    continuation.yield(.response(httpResp))
    continuation.yield(.data(Data(message.utf8)))
  }
}

enum SchemeError: Error {
  case missingURL
}

// Phase 3 検証用ハーネス。xterm.js + 単一 PTY + UTF-8 境界ストレステスト + Socket inbound。
private func ptyHarnessHTML(socketPath: String) -> String {
  let userHome = FileManager.default.homeDirectoryForCurrentUser.path
  return """
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
      <style>
        body { font-family: -apple-system, sans-serif; margin: 0; padding: 12px; background: #1e1e1e; color: #eee; }
        .row { margin-bottom: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        button { padding: 6px 10px; font-size: 13px; }
        #term { background: #000; padding: 4px; height: 380px; }
        .status { font-size: 12px; color: #888; }
        h2 { font-size: 13px; margin: 16px 0 4px; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; }
        #socketLog { background: #111; border: 1px solid #333; padding: 6px; font-family: Menlo, monospace; font-size: 11px; height: 140px; overflow: auto; white-space: pre-wrap; }
        code { background: #111; padding: 2px 4px; border-radius: 3px; font-size: 11px; }
      </style>
    </head>
    <body>
      <h2>PTY</h2>
      <div class="row">
        <button onclick="ptySpawn()">spawn /bin/zsh</button>
        <button onclick="ptyKill()" id="killBtn" disabled>kill (SIGHUP)</button>
        <span class="status" id="status">no pty</span>
      </div>
      <div class="row">
        <button onclick="stress('emoji')">stress: 100k 🍣</button>
        <button onclick="stress('mixed')">stress: 50k mixed</button>
        <button onclick="stress('cjk')">stress: 100k CJK</button>
        <button onclick="echoMb()">echo 日本語🍣</button>
      </div>
      <div id="term"></div>

      <h2>Socket inbound (Unix Domain Socket NDJSON)</h2>
      <div class="row">
        <span class="status">socket: <code id="sockPath">\(socketPath)</code></span>
      </div>
      <div class="row">
        <span class="status">test: <code>echo '{"hook":{"event":"session-start","ptyId":1}}' | nc -w 1 -U \(socketPath)</code></span>
      </div>
      <div class="row">
        <span class="status">test: <code>echo '{"open":{"targetPath":"/path/to/repo"}}' | nc -w 1 -U \(socketPath)</code></span>
      </div>
      <div id="socketLog"></div>

      <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
      <script>
        const term = new Terminal({
          fontFamily: 'Menlo, monospace',
          fontSize: 12,
          theme: { background: '#000000', foreground: '#dddddd' },
          cursorBlink: true,
          convertEol: false,
          scrollback: 10000,
        });
        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        const termEl = document.getElementById('term');
        term.open(termEl);
        fit.fit();
        term.focus();
        termEl.addEventListener('click', () => term.focus());

        let currentPtyId = null;

        async function rpc(path, body) {
          const res = await fetch(`gozd-rpc://localhost${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`RPC ${path} failed: ${res.status} ${text}`);
          }
          return res.json();
        }

        async function ptySpawn() {
          if (currentPtyId !== null) return;
          term.reset();
          term.options.cursorBlink = true;
          const env = {
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            LANG: 'en_US.UTF-8',
            HOME: '\(userHome)',
            PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          };
          const out = await rpc('/pty/spawn', {
            dir: '\(userHome)',
            executable: '/bin/zsh',
            args: ['/bin/zsh', '-i'],
            env,
            rows: term.rows,
            cols: term.cols,
          });
          currentPtyId = Number(out.ptyId);
          document.getElementById('status').textContent = 'pty id=' + currentPtyId;
          document.getElementById('killBtn').disabled = false;
        }

        async function ptyKill() {
          if (currentPtyId === null) return;
          await rpc('/pty/kill', { ptyId: currentPtyId });
        }

        async function ptyWriteText(s) {
          if (currentPtyId === null) return;
          const bytes = new TextEncoder().encode(s);
          let bin = '';
          for (const b of bytes) bin += String.fromCharCode(b);
          await rpc('/pty/write', { ptyId: currentPtyId, data: btoa(bin) });
        }

        term.onData((s) => { ptyWriteText(s); });

        async function echoMb() {
          await ptyWriteText('echo 日本語あいうえお🍣🍱🍙🍡\\n');
        }

        async function stress(kind) {
          let cmd = '';
          if (kind === 'emoji') {
            cmd = `python3 -c "import sys; sys.stdout.write('🍣' * 100000)"\\n`;
          } else if (kind === 'mixed') {
            cmd = `python3 -c "import sys; sys.stdout.write(('あいうえお🍣 sushi 寿司🍱🍙🍡🍵 hello world\\\\n') * 50000)"\\n`;
          } else if (kind === 'cjk') {
            cmd = `python3 -c "import sys; sys.stdout.write('一二三四五六七八九十' * 10000)"\\n`;
          }
          await ptyWriteText(cmd);
        }

        const socketLog = document.getElementById('socketLog');
        function logSocket(line) {
          const ts = new Date().toISOString().slice(11, 23);
          socketLog.textContent = `[${ts}] ${line}\\n` + socketLog.textContent;
        }

        window.__gozdReceive = function(type, payload) {
          if (type === 'ptyText') {
            if (payload.id !== currentPtyId) return;
            term.write(payload.text);
          } else if (type === 'ptyExit') {
            const r = payload.reason;
            const desc = r.kind === 'exited'
              ? `exit code ${r.exitCode}`
              : r.kind === 'signaled'
                ? `killed by signal ${r.signal}${r.coreDumped ? ' (core)' : ''}`
                : `stopped`;
            term.write(`\\r\\n\\x1b[33m[pty:${payload.id} ${desc}]\\x1b[0m\\r\\n`);
            term.options.cursorBlink = false;
            if (payload.id === currentPtyId) {
              currentPtyId = null;
              document.getElementById('status').textContent = 'no pty';
              document.getElementById('killBtn').disabled = true;
            }
          } else if (type === 'hook') {
            logSocket('hook ' + JSON.stringify(payload));
          } else if (type === 'gozdOpen') {
            logSocket('gozdOpen ' + JSON.stringify(payload));
          }
        };

        window.addEventListener('resize', () => {
          fit.fit();
          if (currentPtyId !== null) {
            rpc('/pty/resize', { ptyId: currentPtyId, rows: term.rows, cols: term.cols });
          }
        });
      </script>
    </body>
    </html>
    """
}
