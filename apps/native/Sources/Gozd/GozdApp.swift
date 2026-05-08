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
  @State private var page: WebPage = makePage()

  var body: some View {
    WebView(page)
      .task {
        let html = ptyHarnessHTML()
        do {
          for try await _ in page.load(html: html, baseURL: URL(string: "gozd-app://localhost/")!) {
          }
        } catch {
          print("page.load failed: \(error)")
        }
      }
  }
}

// WebPage は @MainActor。dispatcher の callback は background queue から呼ばれるため、
// 弱参照を保持する @MainActor クラスで包んで Task hop で push する。
@MainActor
final class WebPageHolder {
  weak var page: WebPage?
}

@MainActor
private func makePage() -> WebPage {
  var config = WebPage.Configuration()
  let holder = WebPageHolder()

  // PTY 出力 (UTF8StreamDecoder で境界保留済みの確定 String) を WebPage に push。
  // callJavaScript は @MainActor なので Task で hop する。
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

  let dispatcher = RpcDispatcher(
    configDir: defaultConfigDir(),
    onPtyText: onPtyText,
    onPtyExit: onPtyExit
  )
  config.urlSchemeHandlers[URLScheme("gozd-rpc")!] = RpcSchemeHandler(dispatcher: dispatcher)
  let page = WebPage(configuration: config)
  page.isInspectable = true
  holder.page = page
  return page
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

private func defaultConfigDir() -> String {
  let home = FileManager.default.homeDirectoryForCurrentUser
  return home.appendingPathComponent(".config/gozd").path
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

// Phase 3 検証用ハーネス。xterm.js + 単一 PTY + UTF-8 境界ストレステスト。
// proto3 JSON のフィールド名（camelCase）に合わせる: ptyId / executable / args / env / rows / cols / data。
private func ptyHarnessHTML() -> String {
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
        #term { background: #000; padding: 4px; height: 480px; }
        .status { font-size: 12px; color: #888; }
      </style>
    </head>
    <body>
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
          // proto3 JSON の bytes は base64 文字列。btoa は ASCII 専用なので UTF-8 を経由する。
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

        // Swift → JS の唯一のエントリポイント。
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
