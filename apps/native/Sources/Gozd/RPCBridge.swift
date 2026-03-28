import Foundation
import WebKit

/// WebView ↔ Swift 間の RPC 通信ブリッジ
///
/// 通信パターン:
/// - request (WebView → Swift → WebView):
///   JS が fetch("gozd-rpc://{name}", { body }) を発行
///   → URLSchemeHandler が Swift 側ハンドラーを呼び出し
///   → レスポンス JSON を返却
///
/// - message (Swift → WebView):
///   Swift が callJavaScript("window.__gozdReceive(type, payload)") を呼び出し
///   → JS 側のリスナーが受信
@Observable
final class RPCBridge: @unchecked Sendable {
    private var requestHandlers: [String: @Sendable (Data) async throws -> Data] = [:]
    private var messageHandlers: [String: @Sendable (Data) throws -> Void] = [:]

    /// レスポンスを返す request ハンドラーを登録
    func registerRequest(
        _ name: String,
        handler: @escaping @Sendable (Data) async throws -> Data
    ) {
        requestHandlers[name] = handler
    }

    /// fire-and-forget メッセージハンドラーを登録
    func registerMessage(
        _ name: String,
        handler: @escaping @Sendable (Data) throws -> Void
    ) {
        messageHandlers[name] = handler
    }

    func handleRequest(name: String, body: Data) async throws -> Data {
        // まず message ハンドラーを確認（fire-and-forget）
        if let msgHandler = messageHandlers[name] {
            try msgHandler(body)
            return Data("null".utf8)
        }
        guard let handler = requestHandlers[name] else {
            throw RPCError.unknownRequest(name)
        }
        return try await handler(body)
    }

    /// Swift → WebView へ一方向メッセージを送信
    @discardableResult
    func sendMessage(to page: WebPage, type: String, payload: String) async -> Bool {
        let js = "window.__gozdReceive?.('\(type)', \(payload))"
        do {
            _ = try await page.callJavaScript(js)
            return true
        } catch {
            return false
        }
    }
}

/// gozd-rpc:// カスタムスキームを処理する URLSchemeHandler（macOS 26 API）
struct RPCSchemeHandler: URLSchemeHandler {
    let bridge: RPCBridge

    func reply(
        for request: URLRequest
    ) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
        let bridge = self.bridge
        return AsyncThrowingStream { continuation in
            guard let url = request.url,
                  let name = url.host
            else {
                continuation.finish(throwing: RPCError.invalidURL)
                return
            }

            let body = request.httpBody ?? Data()
            print("[RPC] \(name) bodySize=\(body.count)")

            Task {
                do {
                    let responseData = try await bridge.handleRequest(
                        name: name, body: body)
                    print("[RPC] \(name) responseSize=\(responseData.count)")

                    let response = HTTPURLResponse(
                        url: url,
                        statusCode: 200,
                        httpVersion: "HTTP/1.1",
                        headerFields: [
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*",
                        ]
                    )!
                    continuation.yield(.response(response))
                    continuation.yield(.data(responseData))
                    continuation.finish()
                } catch {
                    print("[RPC] \(name) error: \(error)")
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}

enum RPCError: Error, LocalizedError {
    case unknownRequest(String)
    case invalidURL

    var errorDescription: String? {
        switch self {
        case .unknownRequest(let name): "Unknown RPC request: \(name)"
        case .invalidURL: "Invalid RPC URL"
        }
    }
}
