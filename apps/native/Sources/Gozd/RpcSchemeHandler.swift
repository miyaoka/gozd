import Foundation
import GozdCore
import WebKit

// `gozd-rpc://` URLSchemeHandler。renderer の `fetch("gozd-rpc://localhost/<path>", {...})` を
// `RpcDispatcher` に橋渡しする HTTP-style 包装層。Status code は 200 / 404 / 500 の 3 種だけ。
//
// renderer 側は `Error("RPC ${path} failed: ${status} ${text}")` で再 raise するため、500 body
// の品質 (= `Error.description`) が UI 通知の識別性を直接決める。dispatcher から throw する
// Error 型は `CustomStringConvertible` で人間可読な identifier を提供する契約。

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
          // 500 response の body は `"\(error)"` （= `String(describing:)`）で組み立てる。
          // Swift は `CustomStringConvertible` 準拠を優先するため、dispatcher から
          // throw する Error 型は `CustomStringConvertible` で人間可読な identifier
          // を提供する契約とする（例: `PTYError` の case 名 + errno + strerror）。
          // この経路は renderer 側で `Error(\`RPC ${path} failed: ${res.status} ${text}\`)`
          // として再 raise されるため、Error の `description` 品質が renderer 通知の
          // 識別性を決定する。
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
