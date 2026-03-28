import Foundation
import UniformTypeIdentifiers
import WebKit

/// gozd-file:// カスタムスキームでファイルを配信する URLSchemeHandler
///
/// URL フォーマット:
/// - `gozd-file://git/{relPath}` — git show HEAD:path でファイル内容を返す
/// - `gozd-file://fs/{relPath}` — ファイルシステムから直接返す
///
/// ディレクトリは外部から `rootDirectory` で設定する。
/// パス検証により root 外へのアクセスを遮断する。
struct FileSchemeHandler: URLSchemeHandler {
    /// 現在のワークスペースルートを取得するクロージャ
    let rootProvider: @Sendable () -> String?

    func reply(
        for request: URLRequest
    ) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
        let rootProvider = self.rootProvider
        return AsyncThrowingStream { continuation in
            Task {
                do {
                    let (response, data) = try await handleFileRequest(
                        request: request,
                        rootProvider: rootProvider
                    )
                    continuation.yield(.response(response))
                    continuation.yield(.data(data))
                    continuation.finish()
                } catch let error as FileServerError {
                    let response = HTTPURLResponse(
                        url: request.url ?? URL(string: "gozd-file://error")!,
                        statusCode: error.statusCode,
                        httpVersion: "HTTP/1.1",
                        headerFields: [
                            "Content-Type": "text/plain",
                            "Access-Control-Allow-Origin": "*",
                        ]
                    )!
                    continuation.yield(.response(response))
                    continuation.yield(.data(Data(error.message.utf8)))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}

// MARK: - リクエスト処理

private func handleFileRequest(
    request: URLRequest,
    rootProvider: @Sendable () -> String?
) async throws(FileServerError) -> (HTTPURLResponse, Data) {
    guard let url = request.url else {
        throw .badRequest("Invalid URL")
    }

    // GET/HEAD のみ許可
    let method = request.httpMethod ?? "GET"
    guard method == "GET" || method == "HEAD" else {
        throw .methodNotAllowed
    }

    guard let root = rootProvider() else {
        throw .forbidden("No workspace root")
    }

    // URL パース: gozd-file://git/path/to/file or gozd-file://fs/path/to/file
    guard let host = url.host else {
        throw .badRequest("Missing source type")
    }

    let relPath = String(url.path.dropFirst()) // 先頭の "/" を除去
    guard !relPath.isEmpty else {
        throw .notFound("Empty path")
    }

    // MIME タイプを推定
    let contentType = mimeType(for: relPath)
    let headers = [
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
    ]

    switch host {
    case "git":
        let data = try await fetchGitFile(root: root, relPath: relPath)
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        return (response, data)

    case "fs":
        let data = try await readFsFile(root: root, relPath: relPath)
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        return (response, data)

    default:
        throw .notFound("Unknown source: \(host)")
    }
}

/// git show HEAD:{relPath} でファイル内容を取得
private func fetchGitFile(root: String, relPath: String) async throws(FileServerError) -> Data {
    // Git 論理パスの検証（realpath は使わない）
    guard PathValidator.isInsideRoot(root: root, relPath: relPath) else {
        throw .forbidden("Path outside workspace root")
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = ["show", "HEAD:\(relPath)"]
    process.currentDirectoryURL = URL(fileURLWithPath: root)

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()

    do {
        try process.run()
    } catch {
        throw .notFound("git show failed: \(error.localizedDescription)")
    }

    process.waitUntilExit()

    guard process.terminationStatus == 0 else {
        throw .notFound("git show HEAD:\(relPath) failed (exit \(process.terminationStatus))")
    }

    return pipe.fileHandleForReading.readDataToEndOfFile()
}

/// ファイルシステムからファイルを読み取る（realpath でパス検証）
private func readFsFile(root: String, relPath: String) async throws(FileServerError) -> Data {
    guard let resolvedPath = PathValidator.resolveExistingFsPath(root: root, relPath: relPath)
    else {
        throw .forbidden("Path outside workspace root or does not exist")
    }

    let url = URL(fileURLWithPath: resolvedPath)
    do {
        return try Data(contentsOf: url)
    } catch {
        throw .notFound("Failed to read file: \(error.localizedDescription)")
    }
}

// MARK: - パス検証

/// ファイルパスの安全性を検証するユーティリティ
enum PathValidator {
    /// C の realpath(3) を呼び出し、シンボリックリンクを解決した絶対パスを返す
    static func resolveRealPath(_ path: String) -> String? {
        path.withCString { ptr -> String? in
            guard let resolved = Darwin.realpath(ptr, nil) else { return nil }
            defer { free(resolved) }
            return String(cString: resolved)
        }
    }

    /// Git 論理パスの検証（realpath は使わない）
    static func isInsideRoot(root: String, relPath: String) -> Bool {
        let rootURL = URL(fileURLWithPath: root).standardized
        let resolvedURL = URL(fileURLWithPath: relPath, relativeTo: rootURL).standardized
        let relative = resolvedURL.path.hasPrefix(rootURL.path)
        return relative
    }

    /// 既存ファイルの検証（realpath で symlink 解決 + root 検証）
    static func resolveExistingFsPath(root: String, relPath: String) -> String? {
        let rootURL = URL(fileURLWithPath: root).standardized
        let resolvedURL = URL(fileURLWithPath: relPath, relativeTo: rootURL).standardized
        let resolvedPath = resolvedURL.path

        // realpath でシンボリックリンクを解決
        guard let realPath = resolveRealPath(resolvedPath) else { return nil }
        guard let realRoot = resolveRealPath(root) else { return nil }

        // 実パスが root 配下であることを確認
        guard realPath == realRoot || realPath.hasPrefix(realRoot + "/") else {
            return nil
        }

        // ファイルが存在することを確認
        guard FileManager.default.fileExists(atPath: realPath) else {
            return nil
        }

        return realPath
    }

    /// 未存在ファイルの検証（親ディレクトリを realpath で検証）
    static func resolveCreatableFsPath(root: String, relPath: String) -> String? {
        let rootURL = URL(fileURLWithPath: root).standardized
        let resolvedURL = URL(fileURLWithPath: relPath, relativeTo: rootURL).standardized
        let resolvedPath = resolvedURL.path
        let parentPath = (resolvedPath as NSString).deletingLastPathComponent
        let fileName = (resolvedPath as NSString).lastPathComponent

        guard let realParent = resolveRealPath(parentPath) else { return nil }
        guard let realRoot = resolveRealPath(root) else { return nil }

        guard realParent == realRoot || realParent.hasPrefix(realRoot + "/") else {
            return nil
        }

        return (realParent as NSString).appendingPathComponent(fileName)
    }
}

// MARK: - ファイル読み取りユーティリティ

/// ファイル内容の読み取り結果
struct FileReadResult {
    let content: String
    let isBinary: Bool
    var isDirectory: Bool = false
    var notFound: Bool = false
}

/// ファイル内容を読み取る（バイナリ判定・サイズ制限付き）
func readFileContent(absolutePath: String) -> FileReadResult {
    let fm = FileManager.default

    var isDir: ObjCBool = false
    guard fm.fileExists(atPath: absolutePath, isDirectory: &isDir) else {
        return FileReadResult(content: "", isBinary: false, notFound: true)
    }

    if isDir.boolValue {
        return FileReadResult(content: "", isBinary: false, isDirectory: true)
    }

    let maxFileSize = 1_024 * 1_024  // 1MB

    guard let attrs = try? fm.attributesOfItem(atPath: absolutePath),
        let fileSize = attrs[.size] as? Int
    else {
        return FileReadResult(content: "", isBinary: false, notFound: true)
    }

    if fileSize > maxFileSize {
        return FileReadResult(content: "", isBinary: true)
    }

    guard let data = fm.contents(atPath: absolutePath) else {
        return FileReadResult(content: "", isBinary: false, notFound: true)
    }

    // NUL バイトの有無でバイナリ判定（git と同じ方式）
    if data.contains(0x00) {
        return FileReadResult(content: "", isBinary: true)
    }

    guard let content = String(data: data, encoding: .utf8) else {
        return FileReadResult(content: "", isBinary: true)
    }

    return FileReadResult(content: content, isBinary: false)
}

// MARK: - MIME タイプ推定

/// 拡張子から MIME タイプを推定する
private func mimeType(for path: String) -> String {
    let ext = (path as NSString).pathExtension.lowercased()
    guard !ext.isEmpty else {
        return "application/octet-stream"
    }

    if let utType = UTType(filenameExtension: ext) {
        return utType.preferredMIMEType ?? "application/octet-stream"
    }

    return "application/octet-stream"
}

// MARK: - エラー型

enum FileServerError: Error {
    case badRequest(String)
    case forbidden(String)
    case notFound(String)
    case methodNotAllowed

    var statusCode: Int {
        switch self {
        case .badRequest: 400
        case .forbidden: 403
        case .notFound: 404
        case .methodNotAllowed: 405
        }
    }

    var message: String {
        switch self {
        case .badRequest(let msg): msg
        case .forbidden(let msg): msg
        case .notFound(let msg): msg
        case .methodNotAllowed: "Method Not Allowed"
        }
    }
}
