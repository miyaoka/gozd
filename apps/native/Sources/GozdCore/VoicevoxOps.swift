import AppKit
import Foundation
import os

// VOICEVOX エンジン（HTTP localhost:50021）への薄いラッパー。
//
// 設計判断:
//
// 1. **HTTP は URLSession で叩く**。エンジン本体（VOICEVOX.app）は別インストール、
//    gozd は接続するだけ。
//
// 2. **launch は VOICEVOX.app 同梱の engine バイナリ `vv-engine/run` を直接 spawn する**。
//    VOICEVOX/voicevox_engine は GUI repo と独立した別 repo として headless 利用を正規
//    ルートで提供しており、`.app` 同梱の `vv-engine/run` はその engine 本体。GUI 経由
//    を介さずこれを直接起動するのが公式設計に沿う。インストールパスは Launch Services
//    (`NSWorkspace.shared.urlForApplication(withBundleIdentifier:)`) で `jp.hiroshiba.voicevox`
//    から解決し、`/Applications` 配下に限らず `~/Applications` や別ボリュームインストール
//    にも追従する。stdout / stderr は親 (gozd) を継承させ、engine の起動失敗ログを観察可能
//    に保つ。spawn 後は `spawnedEngine` で `Process` を保持し、`terminationHandler` で
//    即死を stderr に通知できるようにする。
//
// 3. **再生は呼び出し側（renderer）の責務**。speak は wav バイト列のみ返す。
//    renderer の HTML Audio API で再生・停止制御する。
public enum VoicevoxOps {
  static let baseUrl = URL(string: "http://127.0.0.1:50021")!

  /// `/speakers` レスポンスの型。1 entry = 1 キャラ ＋ style 配列。
  public struct Speaker: Sendable {
    public struct Style: Sendable {
      public let name: String
      public let id: UInt32
    }
    public let name: String
    public let styles: [Style]
  }

  public static func listSpeakers() async -> [Speaker]? {
    var req = URLRequest(url: baseUrl.appendingPathComponent("speakers"))
    req.timeoutInterval = 5
    do {
      let (data, resp) = try await URLSession.shared.data(for: req)
      guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        StderrLog.write(tag: "VoicevoxOps.listSpeakers", "non-200 status: \(code)")
        return nil
      }
      guard let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        StderrLog.write(tag: "VoicevoxOps.listSpeakers", "root is not array of object")
        return nil
      }
      return arr.compactMap { entry in
        guard let name = entry["name"] as? String,
          let styleArr = entry["styles"] as? [[String: Any]]
        else {
          StderrLog.write(
            tag: "VoicevoxOps.listSpeakers",
            "skipping malformed speaker entry: \(entry)"
          )
          return nil
        }
        let styles: [Speaker.Style] = styleArr.compactMap { s in
          guard let n = s["name"] as? String, let idRaw = s["id"] as? Int,
            let id = UInt32(exactly: idRaw)
          else {
            StderrLog.write(
              tag: "VoicevoxOps.listSpeakers",
              "skipping malformed style entry: \(s)"
            )
            return nil
          }
          return Speaker.Style(name: n, id: id)
        }
        return Speaker(name: name, styles: styles)
      }
    } catch {
      StderrLog.write(tag: "VoicevoxOps.listSpeakers", "request/decode failed: \(error)")
      return nil
    }
  }

  public static func checkEngine() async -> Bool {
    var req = URLRequest(url: baseUrl.appendingPathComponent("version"))
    req.timeoutInterval = 1.5
    do {
      let (_, resp) = try await URLSession.shared.data(for: req)
      guard let http = resp as? HTTPURLResponse else { return false }
      return http.statusCode == 200
    } catch {
      // Engine 未起動時の polling 用途で頻発するため、転送エラー (URLError) はログを出さない。
      // それ以外の予期しない error のみ stderr に残す
      if !(error is URLError) {
        StderrLog.write(tag: "VoicevoxOps.checkEngine", "unexpected error: \(error)")
      }
      return false
    }
  }

  /// spawn した engine プロセスを保持して `terminationHandler` 経路を有効に保つ。
  /// Process が ARC で deinit すると child 監視 channel が閉じるため、参照を残す必要がある。
  /// `ProcessExec.runProcessCollectingOutput` と同じく `OSAllocatedUnfairLock<Process?>` で
  /// 非 Sendable な Process 参照を actor 越しに安全に保持する。
  private static let spawnedEngine = OSAllocatedUnfairLock<Process?>(initialState: nil)

  public static func launch() async -> Bool {
    // 既に engine が応答していれば spawn しない (renderer 側の checkEngine と二重 guard。
    // renderer→native RPC の往復で開く race 窓を縮める)
    if await checkEngine() {
      return true
    }

    let bundleId = "jp.hiroshiba.voicevox"
    let engineRelativePath = "Contents/Resources/vv-engine/run"

    let appUrl = await MainActor.run {
      NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
    }
    guard let appUrl else {
      StderrLog.write(tag: "VoicevoxOps.launch", "VOICEVOX.app not found (bundleId=\(bundleId))")
      return false
    }
    // symlink / mount alias を経由する場合に備えて実体パスへ解決
    let resolvedAppUrl = appUrl.resolvingSymlinksInPath()
    let engineUrl = resolvedAppUrl.appendingPathComponent(engineRelativePath)
    guard FileManager.default.isExecutableFile(atPath: engineUrl.path) else {
      StderrLog.write(
        tag: "VoicevoxOps.launch", "engine binary not executable at \(engineUrl.path)")
      return false
    }

    let process = Process()
    process.executableURL = engineUrl
    // stdout / stderr は親 (gozd) を継承させる。engine がモデルロード失敗 / dyld 解決失敗等
    // で起動できないケースのログを gozd の stderr に流して観察可能性を保つ。継承経路なら
    // Pipe を介さないため pipe 詰まりも構造的に起きない
    process.terminationHandler = { proc in
      // spawn 直後に即死した場合、起動成功扱いで return した後 renderer 側は 10 秒の
      // waitForEngine タイムアウトを踏む。stderr に痕跡を残して原因切り分けを可能にする。
      // 「死んだ engine 参照」を残さないよう、自分が現在の保持対象なら nil に戻す
      spawnedEngine.withLock { holder in
        if holder === proc { holder = nil }
      }
      StderrLog.write(
        tag: "VoicevoxOps.engine",
        "exited pid=\(proc.processIdentifier) status=\(proc.terminationStatus) reason=\(proc.terminationReason.rawValue)"
      )
    }

    // race protection: checkEngine と run() の間に開く async 窓を、spawnedEngine 占有で塞ぐ。
    // 既に spawn 済みかつ生存している process があれば自分は走らせず true で抜ける。
    // 並行 launch() のうち先に lock を取った方だけが run() に進む
    let canSpawn = spawnedEngine.withLock { holder -> Bool in
      if let existing = holder, existing.isRunning {
        return false
      }
      holder = process
      return true
    }
    guard canSpawn else {
      // skip 時の true は「engine listen 済み」ではなく「別 caller が spawn 中なので
      // 後続は polling で listen を待つ責任」を意味する。caller (renderer の doActivate)
      // は launch ok=true の後に waitForEngine を回す前提なので、この戻り値で問題ない
      StderrLog.write(
        tag: "VoicevoxOps.launch",
        "concurrent spawn in-flight; skipping (caller must poll /version)"
      )
      return true
    }

    do {
      try process.run()
      StderrLog.write(
        tag: "VoicevoxOps.launch",
        "spawned engine pid=\(process.processIdentifier) at \(engineUrl.path)"
      )
      // detach: waitUntilExit は呼ばない。engine は親 (gozd) より長生きしてよい
      return true
    } catch {
      // run() が throw した場合は予約した slot を戻す。terminationHandler は run() 失敗時に
      // 呼ばれないため、ここで明示的に nil に戻す必要がある
      spawnedEngine.withLock { holder in
        if holder === process { holder = nil }
      }
      StderrLog.write(tag: "VoicevoxOps.launch", "failed to spawn engine: \(error)")
      return false
    }
  }

  /// 1. `audio_query` で韻律 → 2. `synthesis` で wav バイト列を返す。再生は renderer。
  public static func speak(text: String, speedScale: Double, volumeScale: Double, speakerId: UInt32)
    async -> Data?
  {
    guard let queryData = await audioQuery(text: text, speakerId: speakerId) else { return nil }
    guard
      let mutated = mutateAudioQuery(
        queryData, speedScale: speedScale, volumeScale: volumeScale)
    else { return nil }
    return await synthesize(audioQuery: mutated, speakerId: speakerId)
  }

  private static func audioQuery(text: String, speakerId: UInt32) async -> Data? {
    var comps = URLComponents(url: baseUrl.appendingPathComponent("audio_query"), resolvingAgainstBaseURL: false)!
    comps.queryItems = [
      URLQueryItem(name: "text", value: text),
      URLQueryItem(name: "speaker", value: String(speakerId)),
    ]
    var req = URLRequest(url: comps.url!)
    req.httpMethod = "POST"
    req.timeoutInterval = 10
    do {
      let (data, resp) = try await URLSession.shared.data(for: req)
      guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        StderrLog.write(
          tag: "VoicevoxOps.audioQuery",
          "non-200 status: \(code) (speaker=\(speakerId))"
        )
        return nil
      }
      return data
    } catch {
      StderrLog.write(tag: "VoicevoxOps.audioQuery", "request failed: \(error)")
      return nil
    }
  }

  private static func mutateAudioQuery(_ data: Data, speedScale: Double, volumeScale: Double)
    -> Data?
  {
    guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      StderrLog.write(
        tag: "VoicevoxOps.mutateAudioQuery",
        "failed to parse audio_query response as JSON object"
      )
      return nil
    }
    json["speedScale"] = speedScale
    json["volumeScale"] = volumeScale
    do {
      return try JSONSerialization.data(withJSONObject: json)
    } catch {
      StderrLog.write(
        tag: "VoicevoxOps.mutateAudioQuery",
        "failed to encode mutated query: \(error)"
      )
      return nil
    }
  }

  private static func synthesize(audioQuery: Data, speakerId: UInt32) async -> Data? {
    var comps = URLComponents(url: baseUrl.appendingPathComponent("synthesis"), resolvingAgainstBaseURL: false)!
    comps.queryItems = [URLQueryItem(name: "speaker", value: String(speakerId))]
    var req = URLRequest(url: comps.url!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = audioQuery
    req.timeoutInterval = 60
    do {
      let (data, resp) = try await URLSession.shared.data(for: req)
      guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        StderrLog.write(
          tag: "VoicevoxOps.synthesize",
          "non-200 status: \(code) (speaker=\(speakerId))"
        )
        return nil
      }
      return data
    } catch {
      StderrLog.write(tag: "VoicevoxOps.synthesize", "request failed: \(error)")
      return nil
    }
  }
}
