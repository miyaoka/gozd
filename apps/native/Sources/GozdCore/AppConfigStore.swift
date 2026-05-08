import Foundation
import GozdProto

// ユーザー設定の永続化（`~/.config/gozd/config.json`）。
//
// 設計判断:
//
// 1. **AppStateStore と同一流儀**。proto JSON を永続化形式に流用、
//    SwiftProtobuf の `jsonString()` でファイル I/O。
//
// 2. **load 時にファイル不在ならデフォルト値**を返す（初回起動）。
//    proto3 のフィールドはデフォルト値持ちなので空 message を返せばよい。
//
// 3. **save は atomic write**（途中停止で壊れた中間状態を残さない）。
public final class AppConfigStore {
  private let filePath: String

  public init(configDir: String) {
    self.filePath = (configDir as NSString).appendingPathComponent("config.json")
  }

  public func load() throws -> Gozd_V1_AppConfig {
    if !FileManager.default.fileExists(atPath: filePath) {
      return Gozd_V1_AppConfig()
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
    let json = String(decoding: data, as: UTF8.self)
    return try Gozd_V1_AppConfig(jsonString: json)
  }

  public func save(_ config: Gozd_V1_AppConfig) throws {
    try ensureDirectory()
    let json = try config.jsonString()
    try json.write(toFile: filePath, atomically: true, encoding: .utf8)
  }

  private func ensureDirectory() throws {
    let dirPath = (filePath as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(
      atPath: dirPath, withIntermediateDirectories: true)
  }
}
