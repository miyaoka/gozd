import Foundation
import GozdCore
import UniformTypeIdentifiers
import WebKit

// `gozd-app://localhost/<path>` を `.app/Contents/Resources/app/views/main/<path>` にマップする。
//
// 新 SwiftUI `WebPage` API には `loadFileURL(_:allowingReadAccessTo:)` 相当が無く、file://
// 直ロードでは subresource (`/assets/*.js` 等) が WKWebView sandbox に弾かれる。
// WWDC25「Meet WebKit for SwiftUI」公式パターンに従い custom scheme で serve する。
//
// path traversal 防止: `resolveContained` (FilePath.lexicallyResolving) で relPath を
// `bundledRoot` 配下へ閉じ込める。`gozd-app://` は renderer から fetch 可能なため、
// XSS 経由で bundle 外を読まれないよう構造的に防ぐ (containment の SSOT は PathContainment.swift)。

struct BundleAssetSchemeHandler: URLSchemeHandler {
  /// `.app` 内 renderer 配置ルート。Bundle が無い (swift run 直叩き等) と nil。
  static var bundledRoot: URL? {
    Bundle.main.resourceURL?.appendingPathComponent("app/views/main", isDirectory: true)
  }

  func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
    AsyncThrowingStream { continuation in
      Task {
        guard let url = request.url else {
          continuation.finish(throwing: SchemeError.missingURL)
          return
        }
        guard let root = Self.bundledRoot else {
          continuation.finish(throwing: URLError(.fileDoesNotExist))
          return
        }
        let relPath = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        let normalized = relPath.isEmpty ? "index.html" : relPath
        // path traversal 防止: relPath を bundledRoot 配下へ閉じ込める。bundle 外へ
        // 抜ける (`..` / 絶対パス) なら nil → fileDoesNotExist。
        guard let containedPath = resolveContained(base: root.path, subpath: normalized) else {
          continuation.finish(throwing: URLError(.fileDoesNotExist))
          return
        }
        let fileURL = URL(fileURLWithPath: containedPath)
        do {
          let data = try Data(contentsOf: fileURL)
          let mime =
            UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
          let resp = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": mime, "Content-Length": "\(data.count)"]
          )!
          continuation.yield(.response(resp))
          continuation.yield(.data(data))
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
    }
  }
}
