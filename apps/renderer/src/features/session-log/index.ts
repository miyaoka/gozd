// session-log feature の公開 API。
//
// Claude セッションログ (`~/.claude/projects/<encoded>/*.jsonl`) を扱う関心が複数
// feature にまたがる (sidebar の task ⋮ メニュー dialog / terminal 右上の preview) ため、
// 独立 feature として切り出している。共有データ取得は `useSessionLogLive` 1 つで賄い、
// 表示の違いは各 consumer 側に閉じる。
export { parseSessionLog, type TranscriptEvent } from "./sessionLog";
export { default as SessionLogDialog } from "./SessionLogDialog.vue";
export { useSessionLogLive } from "./useSessionLogLive";
export { useSessionLogViewer } from "./useSessionLogViewer";
