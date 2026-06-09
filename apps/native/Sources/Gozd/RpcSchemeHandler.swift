import Foundation
import GozdCore
import WebKit

// `gozd-rpc://` URLSchemeHandler。renderer の `fetch("gozd-rpc://localhost/<path>", {...})` を
// `RpcDispatcher` に橋渡しする HTTP-style 包装層。Status code は 200 / 404 / 500 の 3 種だけ。
//
// renderer 側は `Error("RPC ${path} failed: ${status} ${text}")` で再 raise するため、500 body
// の品質 (= `Error.description`) が UI 通知の識別性を直接決める。dispatcher から throw する
// Error 型は `CustomStringConvertible` で人間可読な identifier を提供する契約。
//
// セキュリティ規律 (`Access-Control-Allow-Origin` の運用):
//
// WKWebView (`macOS 26 WebPage` + `URLSchemeHandler`) は custom scheme の fetch でも標準 CORS
// check を適用し、response の `Access-Control-Allow-Origin` ヘッダで cross-origin fetch の許可を
// 判定する。dev (Vite) origin と build (gozd-app) origin はどちらも `gozd-rpc://localhost` から
// 見て cross-origin になるため、ヘッダ無しでは renderer 側 `fetch()` が TypeError で reject する。
// 詳細は `docs/architecture.md` の「CORS 運用規律」セクション参照。
//
// 採用した防御: **Origin allowlist + 明示 echo**。request の `Origin` ヘッダが `allowedOrigins`
// (`http://localhost:16873` / `gozd-app://localhost`) に含まれる場合のみ `Access-Control-Allow-Origin`
// に echo back し `Vary: Origin` を併送する。それ以外 (空文字 / 攻撃 origin) はヘッダを返さず
// WebKit に reject させる。`*` (全許可) を残すと renderer 内 XSS が成立したときに任意 origin から
// `/fs/readFileAbsolute` 等で機密テキスト (`.ssh/config` / `.aws/credentials` / `.env*` 等) を
// `fetch()` で回収できる経路が成立するため、それを構造的に塞ぐ規律。
//
// `gozd-file://` 側 (FileServerSchemeHandler) は `<img>` 表示専用で passive content として CORS
// check 対象外、ヘッダ自体を返さない方針で構造が閉じる (前 PR の規律維持)。

/// renderer の正当な fetch origin。build origin (`gozd-app://localhost`) は常に許可、
/// dev origin は env `GOZD_DEV_VITE_PORT` (root の `pnpm dev` script で設定) から
/// `http://localhost:<port>` 固定形式で組み立てる。dev URL の scheme + host は固定契約。
/// allowlist にマッチしない Origin (= 攻撃 origin / 未知 scheme) は CORS ヘッダ無しの response で
/// WebKit に reject させる契約。
///
/// port を変えるときは root `package.json` の `dev` script の `GOZD_DEV_VITE_PORT` 1 箇所だけ
/// 書き換える。Vite (`vite.config.ts`) も同じ env から port を受け取るため drift しない。
private let allowedOrigins: Set<String> = {
  var origins: Set<String> = ["gozd-app://localhost"]  // build app は常に許可
  let env = ProcessInfo.processInfo.environment
  if let port = env["GOZD_DEV_VITE_PORT"], !port.isEmpty {
    origins.insert("http://localhost:\(port)")
  }
  return origins
}()

/// request の `Origin` が allowlist にあるなら echo すべき値、それ以外 nil。
private func resolveAllowOrigin(for request: URLRequest) -> String? {
  guard let origin = request.value(forHTTPHeaderField: "Origin") else { return nil }
  return allowedOrigins.contains(origin) ? origin : nil
}

/// 200 / 404 / 500 共通の HTTPURLResponse 組み立て。CORS ヘッダの運用を 1 箇所に閉じる。
private func makeResponse(
  url: URL, status: Int, contentType: String, allowOriginEcho: String?
) -> HTTPURLResponse {
  var headers: [String: String] = ["Content-Type": contentType]
  if let allowOriginEcho {
    headers["Access-Control-Allow-Origin"] = allowOriginEcho
    headers["Vary"] = "Origin"
  }
  return HTTPURLResponse(
    url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers
  )!
}

struct RpcSchemeHandler: URLSchemeHandler {
  let dispatcher: RpcDispatcher

  func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
    AsyncThrowingStream { continuation in
      Task {
        guard let url = request.url else {
          continuation.finish(throwing: SchemeError.missingURL)
          return
        }
        let allowOriginEcho = resolveAllowOrigin(for: request)
        let body = request.httpBody ?? Data()

        do {
          let respData = try await dispatcher.dispatch(path: url.path, body: body)
          let httpResp = makeResponse(
            url: url, status: 200, contentType: "application/json",
            allowOriginEcho: allowOriginEcho)
          continuation.yield(.response(httpResp))
          continuation.yield(.data(respData))
        } catch RpcError.unknownPath(let p) {
          yield(
            continuation: continuation, status: 404, url: url, message: "unknown RPC: \(p)",
            allowOriginEcho: allowOriginEcho)
        } catch {
          // 500 response の body は `"\(error)"` （= `String(describing:)`）で組み立てる。
          // Swift は `CustomStringConvertible` 準拠を優先するため、dispatcher から
          // throw する Error 型は `CustomStringConvertible` で人間可読な identifier
          // を提供する契約とする（例: `PTYError` の case 名 + errno + strerror）。
          // この経路は renderer 側で `Error(\`RPC ${path} failed: ${res.status} ${text}\`)`
          // として再 raise されるため、Error の `description` 品質が renderer 通知の
          // 識別性を決定する。
          yield(
            continuation: continuation, status: 500, url: url, message: "\(error)",
            allowOriginEcho: allowOriginEcho)
        }
        continuation.finish()
      }
    }
  }

  private func yield(
    continuation: AsyncThrowingStream<URLSchemeTaskResult, any Error>.Continuation,
    status: Int,
    url: URL,
    message: String,
    allowOriginEcho: String?
  ) {
    let httpResp = makeResponse(
      url: url, status: status, contentType: "text/plain; charset=utf-8",
      allowOriginEcho: allowOriginEcho)
    continuation.yield(.response(httpResp))
    continuation.yield(.data(Data(message.utf8)))
  }
}

enum SchemeError: Error {
  case missingURL
}
