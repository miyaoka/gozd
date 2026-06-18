import Foundation
import GozdCore
import UniformTypeIdentifiers
import WebKit

// `gozd-file://localhost/<kind>?dir=<absDir>&path=<relPath>` を `<img src>` に直配信する。
//
// 用途: preview の画像 / SVG 表示。WKWebView は `file://` を直接読めず、また RPC 経由で
// bytes を運ぶと proto3 の `content: string` がバイナリを保持できない問題に当たるため、
// `<img>` 経路だけ別 scheme で raw bytes を返す。テキスト系の preview は従来通り
// `gozd-rpc://` 経由 + UTF-8 string で扱う。
//
// 経路:
//   - `/fs` : 作業ツリーの実ファイル（`FSOps.readFileBytes`、`resolveSafe` で path traversal 防止）
//   - `/git`: `git show HEAD:<path>` の出力（`GitOps.showFile`）
//   - `/abs`: worktree 外の絶対パス（`FSOps.readFileBytesAbsolute`、dir 制約なし）。terminal link 等で
//             worktree 外を開いた画像 / SVG 用。テキスト preview の `readFileAbsolute` RPC と同じ
//             「dir 外参照を許す」契約を `<img>` 経路に揃えるためのもの
//
// dir は **絶対パスをクエリで運ぶ**。worktree dir 集合を native 側にミラーすると watch race の
// 温床になるため、handler は呼び出し側責任契約 (= renderer の `<img>` 経路が組み立てる dir) を
// 採用する。`/fs` 側は `FSOps.resolveSafe` が dir 配下に閉じることを保証するため、外部から
// 任意 path を渡されても dir 配下のみが配信される。`/git` 側は dir が git repo でなければ
// `runGit` が失敗する。`/abs` は dir を取らず path 単独（絶対パス）で受ける。
//
// MIME は path の拡張子から `UTType` で sniff する。判定不能は `application/octet-stream` で
// 出すと WebKit が broken-image にしてくれる (silent drop 防止の観点で response は必ず返す)。
//
// セキュリティ:
//   - `Access-Control-Allow-Origin` は意図して付けない。WKWebView の CORS は同 origin の
//     `<img>` 表示には不要 (passive content)、cross-origin の `fetch()` / `canvas getImageData()`
//     は CORS で構造的にブロックされる。`*` で all origin を許可すると tainted canvas / cross-origin
//     fetch の防御層を打ち消し、renderer 内 XSS 経路で任意 path bytes 回収が成立する
//   - `/git` 経路は `validateRelPath` で option 注入 (`-`/`--option`) / NUL / 改行 / `..` を弾く。
//     `GitValidate.swift` の「新規 op を生やす時の checklist」契約に整合させる
//   - `/fs` 経路は `FSOps.readFileBytes` 内の `resolveSafe` が dir 配下に閉じる traversal guard
//     を担い、追加で `validateRelPath` を safety net として呼ぶ
//   - `/abs` 経路は意図的に containment を持たない (worktree 外参照が目的)。テキストの
//     `readFileAbsolute` RPC と同じく任意の絶対パスを読むが、CORS 規律 (Allow-Origin を返さない)
//     により `<img>` 表示のみ可能で `fetch()` / canvas での bytes 回収は構造的に塞がれる。
//     git に渡さないため option 注入 guard (`validateRelPath`) は適用しない (絶対パスを reject するため)

struct FileServerSchemeHandler: URLSchemeHandler {
  func reply(for request: URLRequest) -> AsyncThrowingStream<URLSchemeTaskResult, any Error> {
    AsyncThrowingStream { continuation in
      Task {
        guard let url = request.url else {
          continuation.finish(throwing: SchemeError.missingURL)
          return
        }
        do {
          let kind = (url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path)
          let path = try parsePath(url: url)
          let data = try await fetchBytes(kind: kind, url: url, path: path)
          let mime =
            UTType(filenameExtension: (path as NSString).pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
          let resp = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
              "Content-Type": mime,
              "Content-Length": "\(data.count)",
            ]
          )!
          continuation.yield(.response(resp))
          continuation.yield(.data(data))
          continuation.finish()
        } catch {
          StderrLog.write(
            tag: "FileServerSchemeHandler",
            "serve failed for \(url.absoluteString): \(error)")
          continuation.finish(throwing: error)
        }
      }
    }
  }

  // MARK: - private

  /// 全 kind 共通の `path` クエリ。`/fs` `/git` では worktree 相対パス、`/abs` では絶対パス。
  private func parsePath(url: URL) throws -> String {
    let path = queryValue(url: url, name: "path") ?? ""
    if path.isEmpty {
      throw FileServerError.missingQuery
    }
    return path
  }

  /// `/fs` `/git` 専用の `dir` クエリ（絶対パス）。`/abs` は dir を取らない。
  private func parseDir(url: URL) throws -> String {
    let dir = queryValue(url: url, name: "dir") ?? ""
    if dir.isEmpty {
      throw FileServerError.missingQuery
    }
    return dir
  }

  private func queryValue(url: URL, name: String) -> String? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return nil
    }
    return components.queryItems?.first(where: { $0.name == name })?.value
  }

  private func fetchBytes(kind: String, url: URL, path: String) async throws -> Data {
    switch kind {
    case "fs":
      let dir = try parseDir(url: url)
      // safety net: option 注入 / NUL / 改行 / .. traversal を入口で reject する。
      // FSOps.resolveSafe が traversal を直接 reject するが、checklist 契約として guard を通す。
      try validateRelPath(path)
      return try FSOps.readFileBytes(dir: dir, path: path)
    case "git":
      let dir = try parseDir(url: url)
      try validateRelPath(path)
      return try await GitOps.showFile(dir: dir, relPath: path)
    case "abs":
      // 絶対パスを dir 制約なしで読む。git に渡さないため validateRelPath (絶対パスを reject) は通さない。
      return try FSOps.readFileBytesAbsolute(absolutePath: path)
    default:
      throw FileServerError.unknownKind(kind)
    }
  }
}

enum FileServerError: Error, CustomStringConvertible {
  case invalidURL
  case missingQuery
  case unknownKind(String)

  var description: String {
    switch self {
    case .invalidURL: return "invalid URL components"
    case .missingQuery: return "missing dir or path query parameter"
    case .unknownKind(let kind): return "unknown kind: \(kind) (expected /fs, /git or /abs)"
    }
  }
}
