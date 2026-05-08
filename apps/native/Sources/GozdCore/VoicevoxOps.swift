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

  public static func checkEngine() async -> Bool {
    var req = URLRequest(url: baseUrl.appendingPathComponent("version"))
    req.timeoutInterval = 1.5
    do {
      let (_, resp) = try await URLSession.shared.data(for: req)
      guard let http = resp as? HTTPURLResponse else { return false }
      return http.statusCode == 200
    } catch {
      return false
    }
  }

  public static func launch() async -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-a", "VOICEVOX"]
    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus == 0
    } catch {
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
      guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
      return data
    } catch {
      return nil
    }
  }

  private static func mutateAudioQuery(_ data: Data, speedScale: Double, volumeScale: Double)
    -> Data?
  {
    guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return nil
    }
    json["speedScale"] = speedScale
    json["volumeScale"] = volumeScale
    return try? JSONSerialization.data(withJSONObject: json)
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
      guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
      return data
    } catch {
      return nil
    }
  }
}
