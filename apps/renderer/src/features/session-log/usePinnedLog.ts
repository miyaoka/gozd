/**
 * terminal preview の全文 popover から固定化 (pin) されたメッセージ群の module singleton。
 *
 * pinned window は表示中の repo / session / terminal と独立して存在し続けるため、
 * component ローカルではなく module singleton に置く (`useSessionLogViewer` と同パターン)。
 * 内容は pin 時点のスナップショット (kind + text) で、元セッションのログ参照や
 * watch ライフサイクルには乗らない。元の popover が閉じても消えない独立性が要件のため、
 * ライブ更新はしない。
 *
 * ウィンドウ状態 (位置 / 初期本文サイズ / z / drag handoff) の管理は floating-window の
 * `createFloatingWindows` に委譲する (サイズ受け渡しと handoff の契約はそちらの doc 参照)。
 */
import { createFloatingWindows, type FloatingWindowState } from "../floating-window";

interface PinnedLogData {
  kind: "user" | "assistant";
  /** ヘッダ上段: repo 名 (TerminalLeafTitle と同構成)。未解決は空文字で上段ごと省く。 */
  repoName: string;
  /** RepoIcon 用の GitHub owner。空文字は identicon フォールバック。 */
  repoOwner: string;
  /** ヘッダ下段: session タイトル (+ sub 由来は subagent ラベル)。 */
  title: string;
  text: string;
}

export type PinnedLog = PinnedLogData & FloatingWindowState;

const store = createFloatingWindows<PinnedLogData>();

export function usePinnedLog() {
  const { windows, pin, takeHandoff, close, move, bringToFront } = store;
  return { logs: windows, pin, takeHandoff, close, move, bringToFront };
}
