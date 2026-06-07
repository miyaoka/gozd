import Foundation
import UniformTypeIdentifiers
import WebKit

// `gozd-app://localhost/<path>` を `.app/Contents/Resources/app/views/main/<path>` にマップする。
//
// 新 SwiftUI `WebPage` API には `loadFileURL(_:allowingReadAccessTo:)` 相当が無く、file://
// 直ロードでは subresource (`/assets/*.js` 等) が WKWebView sandbox に弾かれる。
// WWDC25「Meet WebKit for SwiftUI」公式パターンに従い custom scheme で serve する。
//
// path traversal 防止: `..` を含むパスを `standardized` で正規化し、symlink を解決した
// 実体パスが `bundledRoot` 配下にあることを必ず確認する。`gozd-app://` は renderer から
// fetch 可能なため、XSS 経由で bundle 外を読まれないよう構造的に防ぐ。

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
        // path traversal 防止: `..` を含むパスを standardized で正規化し、symlink を
        // 解決した実体パスが bundledRoot 配下にあることを確認する。`gozd-app://` は
        // renderer から fetch 可能なため、XSS 経由で bundle 外を読まれないようにする。
        let candidate = root.appendingPathComponent(normalized).standardized
        let resolvedFile = candidate.resolvingSymlinksInPath()
        let resolvedRoot = root.resolvingSymlinksInPath()
        let rootPath = resolvedRoot.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        guard resolvedFile.path == rootPath || resolvedFile.path.hasPrefix(prefix) else {
          continuation.finish(throwing: URLError(.fileDoesNotExist))
          return
        }
        let fileURL = candidate
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
