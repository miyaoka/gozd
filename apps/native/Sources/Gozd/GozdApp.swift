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
        let html = """
          <!DOCTYPE html>
          <html>
            <body style="font-family: -apple-system; padding: 20px;">
              <h1>gozd Phase 2 dispatcher</h1>
              <button onclick="runEcho()">echo</button>
              <pre id="out"></pre>
              <script>
                async function runEcho() {
                  const res = await fetch("gozd-rpc://localhost/echo", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: "hello from web" })
                  });
                  const json = await res.json();
                  document.getElementById("out").textContent = JSON.stringify(json, null, 2);
                }
              </script>
            </body>
          </html>
          """
        do {
          for try await _ in page.load(html: html, baseURL: URL(string: "gozd-app://localhost/")!) {
          }
        } catch {
          print("page.load failed: \(error)")
        }
      }
  }
}

@MainActor
private func makePage() -> WebPage {
  var config = WebPage.Configuration()
  let dispatcher = RpcDispatcher(
    configDir: defaultConfigDir(),
    // PTY イベントを WebPage に push する経路は Phase 3 で実装する。
    // ここでは stdout に流すだけのプレースホルダ（テキストは UTF8StreamDecoder で
    // 境界保留済みの確定 String）。
    onPtyText: { id, text in
      print("[pty:\(id)] text: \(text.prefix(80))")
    },
    onPtyExit: { id, reason in
      print("[pty:\(id)] exit: \(reason)")
    }
  )
  config.urlSchemeHandlers[URLScheme("gozd-rpc")!] = RpcSchemeHandler(dispatcher: dispatcher)
  let page = WebPage(configuration: config)
  page.isInspectable = true
  return page
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
