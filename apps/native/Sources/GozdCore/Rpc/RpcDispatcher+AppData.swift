import Foundation
import GozdProto

// 永続データ系 RPC handler。AppStateStore (ウィンドウ状態) / AppConfigStore (ユーザー設定) /
// ProjectConfigStore (プロジェクト別設定) への薄いラッパー。

extension RpcDispatcher {
  // MARK: - AppState (グローバルなウィンドウ状態 / repo 並び順 / 折りたたみ状態)

  func handleLoadAppState(_ body: Data) throws -> Data {
    _ = try Gozd_V1_LoadAppStateRequest(jsonUTF8Data: body)
    let state = try appState.load()
    var resp = Gozd_V1_LoadAppStateResponse()
    resp.state = state
    return try resp.jsonUTF8Data()
  }

  func handleSaveAppState(_ body: Data) throws -> Data {
    let req = try Gozd_V1_SaveAppStateRequest(jsonUTF8Data: body)
    try appState.save(req.state)
    return try Gozd_V1_SaveAppStateResponse().jsonUTF8Data()
  }

  // MARK: - AppConfig (ユーザー設定: VOICEVOX 等)

  func handleLoadAppConfig(_ body: Data) throws -> Data {
    _ = try Gozd_V1_LoadAppConfigRequest(jsonUTF8Data: body)
    let config = try appConfig.load()
    var resp = Gozd_V1_LoadAppConfigResponse()
    resp.config = config
    return try resp.jsonUTF8Data()
  }

  func handleSaveAppConfig(_ body: Data) throws -> Data {
    let req = try Gozd_V1_SaveAppConfigRequest(jsonUTF8Data: body)
    try appConfig.save(req.config)
    return try Gozd_V1_SaveAppConfigResponse().jsonUTF8Data()
  }

  // MARK: - ProjectConfig (プロジェクト別設定: worktreeSymlinks 等)

  func handleProjectConfigLoad(_ body: Data) throws -> Data {
    let req = try Gozd_V1_ProjectConfigLoadRequest(jsonUTF8Data: body)
    let cfg = try projectConfig.load(dir: req.dir)
    var resp = Gozd_V1_ProjectConfigLoadResponse()
    resp.config = cfg
    return try resp.jsonUTF8Data()
  }

  func handleProjectConfigSave(_ body: Data) throws -> Data {
    let req = try Gozd_V1_ProjectConfigSaveRequest(jsonUTF8Data: body)
    try projectConfig.save(dir: req.dir, config: req.config)
    return try Gozd_V1_ProjectConfigSaveResponse().jsonUTF8Data()
  }
}
