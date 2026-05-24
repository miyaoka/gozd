import Foundation

// VOICEVOX エンジン（HTTP localhost:50021）への薄いラッパー。
//
// 設計判断:
//
// 1. **HTTP は URLSession で叩く**。エンジン本体（VOICEVOX.app）は別インストール、
//    gozd は接続するだけ。
//
// 2. **launch は `open -a VOICEVOX`** に投げる（ユーザーが手動で起動済みでも no-op）。
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

  public static func launch() async -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-a", "VOICEVOX"]
    process.environment = ProcessInfo.processInfo.environment
    do {
      try process.run()
      process.waitUntilExit()
      if process.terminationStatus != 0 {
        StderrLog.write(
          tag: "VoicevoxOps.launch",
          "open -a VOICEVOX exited with status \(process.terminationStatus)"
        )
      }
      return process.terminationStatus == 0
    } catch {
      StderrLog.write(tag: "VoicevoxOps.launch", "failed to spawn open: \(error)")
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
