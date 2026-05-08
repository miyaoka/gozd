import Foundation
import GozdProto

// アプリ状態の永続化（`~/.config/gozd/app-state.json`）。
//
// 設計判断:
//
// 1. **proto JSON を永続化形式に流用**。SwiftProtobuf の `jsonString()` /
//    `init(jsonString:)` を使う。ワイヤーフォーマットと storage 形式を同じ
//    proto 型で揃え、Codable との二重管理を避ける。
//
// 2. **configDir は init で固定**。`~/.config/gozd` はサーバーワイドな初期化
//    時パラメータでリクエスト毎に変わらないため、issue #310 のステートレス化
//    （worktree dir 必須）の対象外。
//
// 3. **load 時にファイル不在ならデフォルト値**を返す（初回起動）。
//
// 4. **save は atomic write**（`String.write(toFile:atomically:)`）。
//    途中で停止した場合でも JSON 構造の壊れた中間状態を残さない。
public final class AppStateStore {
  private let filePath: String

  public init(configDir: String) {
    self.filePath = (configDir as NSString).appendingPathComponent("app-state.json")
  }

  public func load() throws -> Gozd_V1_AppState {
    if !FileManager.default.fileExists(atPath: filePath) {
      return Gozd_V1_AppState()
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
    let json = String(decoding: data, as: UTF8.self)
    return try Gozd_V1_AppState(jsonString: json)
  }

  public func save(_ state: Gozd_V1_AppState) throws {
    try ensureDirectory()
    let json = try state.jsonString()
    try json.write(toFile: filePath, atomically: true, encoding: .utf8)
  }

  private func ensureDirectory() throws {
    let dirPath = (filePath as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(
      atPath: dirPath, withIntermediateDirectories: true)
  }
}
