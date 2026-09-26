// session-log feature の公開 API。
//
// Claude セッションログ (`~/.claude/projects/<encoded>/*.jsonl`) を扱う関心が複数
// feature にまたがる (sidebar のセッション ⋮ メニュー dialog / terminal 右上の preview /
// undock されたメッセージのフローティングウィンドウ) ため、独立 feature として切り出している。
// 共有データ取得は `useSessionLogLive` 1 つで賄い、発言の判定と見た目は `sessionLogView` の
// 発言の定義を全ての consumer が共有する。
export { parseSessionLog, type TranscriptEvent } from "@gozd/claude-session-log";
export { default as UndockedLogLayer } from "./UndockedLogLayer.vue";
export { default as SessionLogDialog } from "./SessionLogDialog.vue";
export { default as SessionLogMessageBody } from "./SessionLogMessageBody.vue";
export { default as SessionLogSpeechText } from "./SessionLogSpeechText.vue";
export {
  isSameSpeech,
  SPEAKER_SIDE,
  SPEAKER_SURFACE_CLASS,
  speechesOf,
  type Speech,
  type SpeechSpeaker,
} from "./sessionLogView";
export { useUndockedLog } from "./useUndockedLog";
export { useSessionLogLive } from "./useSessionLogLive";
export { useSessionLogViewer } from "./useSessionLogViewer";
