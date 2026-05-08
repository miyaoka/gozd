import SwiftUI
import WebKit
import GozdProto

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
            <h1>gozd Phase 0 echo</h1>
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
          for try await _ in page.load(html: html, baseURL: URL(string: "gozd-app://localhost/")!) {}
        } catch {
          print("page.load failed: \(error)")
        }
      }
  }
}

@MainActor
private func makePage() -> WebPage {
  var config = WebPage.Configuration()
  config.urlSchemeHandlers[URLScheme("gozd-rpc")!] = RpcSchemeHandler()
  let page = WebPage(configuration: config)
  page.isInspectable = true
  return page
}

struct RpcSchemeHandler: URLSchemeHandler {
  func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
    AsyncThrowingStream { continuation in
      Task {
        do {
          guard let url = request.url else {
            continuation.finish(throwing: RpcError.missingURL)
            return
          }
          let path = url.path
          let body = request.httpBody ?? Data()

          switch path {
          case "/echo":
            let req = try Gozd_V1_EchoRequest(jsonUTF8Data: body)
            var resp = Gozd_V1_EchoResponse()
            resp.text = "echo: \(req.text)"
            let respData = try resp.jsonUTF8Data()
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
          default:
            let httpResp = HTTPURLResponse(
              url: url,
              statusCode: 404,
              httpVersion: "HTTP/1.1",
              headerFields: ["Access-Control-Allow-Origin": "*"]
            )!
            continuation.yield(.response(httpResp))
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
    }
  }
}

enum RpcError: Error {
  case missingURL
}
