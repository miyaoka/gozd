import Foundation
import GozdProto
import SwiftProtobuf

// アプリ状態の永続化（`~/.local/state/gozd/app-state.json`）。
//
// 設計判断:
//
// 1. **proto JSON を永続化形式に流用**。SwiftProtobuf の `jsonString()` /
//    `init(jsonString:)` を使う。ワイヤーフォーマットと storage 形式を同じ
//    proto 型で揃え、Codable との二重管理を避ける。
//
// 2. **stateDir は init で固定**。app state は「前回の続き」を表す state であり
//    ユーザー設定 (config) ではないため XDG state ディレクトリ (`~/.local/state/gozd`)
//    に置く。サーバーワイドな初期化時パラメータでリクエスト毎に変わらない。
//
// 3. **load 時にファイル不在ならデフォルト値**を返す（初回起動）。
//    SwiftProtobuf の JSON parse は `ignoreUnknownFields = true` を渡し、
//    将来バージョンで増えたフィールドが入っていても fail させない。
//
// 4. **save は merge + atomic write**。proto3 JSON は SwiftProtobuf / ts-proto
//    のどちらも未知フィールドを出力時に落とすので、storage 上で旧バージョンが
//    新バージョンの追加フィールドを保持できない。これを補うため、save 時には
//    既存ファイルを raw dict として読み、新 state の dict と shallow merge してから
//    書き戻す。これにより未知 top-level フィールドが旧 binary を経由しても残る。
//    `knownTopLevelKeys` は merge 前に existing dict から落として、proto3 JSON が
//    省略する空 repeated / default scalar による「最後の repo を消したのに古い
//    sidebarRepos が残る」事故を防ぐ。proto schema を変えたら同期して更新する。
public final class AppStateStore {
  private let filePath: String

  /// AppState の既知 top-level field 名（proto3 JSON の lower-camel 表記）。
  /// proto schema が変わったらこの set も同期して更新する。
  private static let knownTopLevelKeys: Set<String> = [
    "sidebarRepos",
  ]

  public init(stateDir: String) {
    self.filePath = (stateDir as NSString).appendingPathComponent("app-state.json")
  }

  public func load() throws -> Gozd_V1_AppState {
    if !FileManager.default.fileExists(atPath: filePath) {
      return Gozd_V1_AppState()
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
    let json = String(decoding: data, as: UTF8.self)
    var options = JSONDecodingOptions()
    options.ignoreUnknownFields = true
    return try Gozd_V1_AppState(jsonString: json, options: options)
  }

  public func save(_ state: Gozd_V1_AppState) throws {
    try ensureDirectory()
    let newJSONData = try state.jsonUTF8Data()
    guard
      let newDict = try JSONSerialization.jsonObject(with: newJSONData) as? [String: Any]
    else {
      throw AppStateStoreError.serializationFailed
    }
    var merged: [String: Any] = [:]
    if let existingData = try? Data(contentsOf: URL(fileURLWithPath: filePath)),
      let existingDict = try? JSONSerialization.jsonObject(with: existingData) as? [String: Any]
    {
      merged = existingDict
    }
    // 既知 top-level field を一旦削除してから新値を入れる。proto3 JSON は default
    // scalar / 空 repeated を省略するので、単純な overlay merge だと「最後の repo を消す」
    // のような空化が old 値で上書きされてしまう。
    for k in Self.knownTopLevelKeys { merged.removeValue(forKey: k) }
    for (k, v) in newDict {
      merged[k] = v
    }
    let outData = try JSONSerialization.data(
      withJSONObject: merged, options: [.prettyPrinted, .sortedKeys])
    try outData.write(to: URL(fileURLWithPath: filePath), options: .atomic)
  }

  private func ensureDirectory() throws {
    let dirPath = (filePath as NSString).deletingLastPathComponent
    try FileManager.default.createDirectory(
      atPath: dirPath, withIntermediateDirectories: true)
  }
}

public enum AppStateStoreError: Error {
  case serializationFailed
}
