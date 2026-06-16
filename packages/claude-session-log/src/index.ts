// @gozd/claude-session-log の公開 API。
//
// Claude Code セッションログ (JSONL) の parse 層を framework 非依存で閉じる。生 JSONL を
// transcript イベント列 (TranscriptEvent) に変換する parseSessionLog が中核。Claude Code の
// ログ形式が変わったとき (coordinator 中継の isMeta 化、teammate-message タグ追加など) の
// 追従先をここ 1 箇所に集約する。
//
// このパッケージは UI も gozd 固有のロジックも持たない。生 JSONL 文字列を渡せば transcript
// モデルが返るだけ。表示整形 / subagent 紐付け / タイムライン組み立てなどの view 層は
// 各コンシューマ (gozd renderer など) が持つ。

export {
  parseSessionLog,
  expandAskMessages,
  type TranscriptEvent,
  type ParsedSessionLog,
  type BranchSelection,
  type ImageSource,
} from "./sessionLog";
