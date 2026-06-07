import Foundation
import GozdProto

// VOICEVOX engine 連携の RPC handler。`VoicevoxOps.*` への薄いラッパー。listSpeakers が
// nil で返る (engine 起動失敗 / network) ケースを空 list にフォールバックしつつ silent drop
// 禁止規律として stderr に観察ログを残す。

extension RpcDispatcher {
  func handleVoicevoxLaunch(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_VoicevoxLaunchRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_VoicevoxLaunchResponse()
    resp.ok = await VoicevoxOps.launch()
    return try resp.jsonUTF8Data()
  }

  func handleVoicevoxCheckEngine(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_VoicevoxCheckEngineRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_VoicevoxCheckEngineResponse()
    resp.ok = await VoicevoxOps.checkEngine()
    return try resp.jsonUTF8Data()
  }

  func handleVoicevoxListSpeakers(_ body: Data) async throws -> Data {
    _ = try Gozd_V1_VoicevoxListSpeakersRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_VoicevoxListSpeakersResponse()
    if let speakers = await VoicevoxOps.listSpeakers() {
      resp.speakers = speakers.map { speaker in
        var s = Gozd_V1_VoicevoxSpeaker()
        s.name = speaker.name
        s.styles = speaker.styles.map { style in
          var st = Gozd_V1_VoicevoxSpeakerStyle()
          st.name = style.name
          st.id = style.id
          return st
        }
        return s
      }
    } else {
      StderrLog.write(
        tag: "handleVoicevoxListSpeakers",
        "listSpeakers returned nil; responding with empty list"
      )
    }
    return try resp.jsonUTF8Data()
  }

  func handleVoicevoxSpeak(_ body: Data) async throws -> Data {
    let req = try Gozd_V1_VoicevoxSpeakRequest(jsonUTF8Data: body)
    var resp = Gozd_V1_VoicevoxSpeakResponse()
    if let wav = await VoicevoxOps.speak(
      text: req.text, speedScale: req.speedScale, volumeScale: req.volumeScale,
      speakerId: req.speakerID)
    {
      resp.wav = wav
    }
    return try resp.jsonUTF8Data()
  }
}
