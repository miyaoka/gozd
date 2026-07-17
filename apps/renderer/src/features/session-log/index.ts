// session-log feature の公開 API。
//
// Claude セッションログ (`~/.claude/projects/<encoded>/*.jsonl`) を扱う関心が複数
// feature にまたがる (sidebar の task ⋮ メニュー dialog / terminal 右上の preview /
// undock されたメッセージのフローティングウィンドウ) ため、独立 feature として切り出している。
// 共有データ取得は `useSessionLogLive` 1 つで賄い、表示の違いは各 consumer 側に閉じる。
export { expandAskMessages, parseSessionLog, type TranscriptEvent } from "@gozd/claude-session-log";
export { default as UndockedLogLayer } from "./UndockedLogLayer.vue";
export { default as SessionLogDialog } from "./SessionLogDialog.vue";
export { default as SessionLogMessageBody } from "./SessionLogMessageBody.vue";
export { useUndockedLog } from "./useUndockedLog";
export { useSessionLogLive } from "./useSessionLogLive";
export { useSessionLogViewer } from "./useSessionLogViewer";
