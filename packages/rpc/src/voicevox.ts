// VOICEVOX 音声合成。Engine 起動・疎通確認・発話。

import type { EmptyMessage } from "./common";

export type VoicevoxLaunchRequest = EmptyMessage;
export interface VoicevoxLaunchResponse {
  ok: boolean;
}

export type VoicevoxCheckEngineRequest = EmptyMessage;
export interface VoicevoxCheckEngineResponse {
  ok: boolean;
}

export interface VoicevoxSpeakRequest {
  text: string;
  speedScale: number;
  volumeScale: number;
  speakerId: number;
}
export interface VoicevoxSpeakResponse {
  /** 合成成功時の wav バイト列の base64。失敗時は空。decode と再生は呼び出し側
   * （renderer）の責務。JSON ワイヤでバイナリを運ぶため base64 のまま露出する。 */
  wavBase64: string;
}

/** Engine `/speakers` の薄いラッパー。キャラと style 一覧を返す。 */
export type VoicevoxListSpeakersRequest = EmptyMessage;
export interface VoicevoxListSpeakersResponse {
  speakers: VoicevoxSpeaker[];
}

export interface VoicevoxSpeaker {
  name: string;
  styles: VoicevoxSpeakerStyle[];
}

interface VoicevoxSpeakerStyle {
  name: string;
  id: number;
}
