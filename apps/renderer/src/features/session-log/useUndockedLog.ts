/**
 * terminal preview の全文 popover から切り離し (undock) されたメッセージ群の module singleton。
 *
 * undocked window は表示中の repo / session / terminal と独立して存在し続けるため、
 * component ローカルではなく module singleton に置く (`useSessionLogViewer` と同パターン)。
 * 内容は undock 時点のスナップショット (kind + text) で、元セッションのログ参照や
 * watch ライフサイクルには乗らない。元の popover が閉じても消えない独立性が要件のため、
 * ライブ更新はしない。
 *
 * ウィンドウ状態 (位置 / 初期中身サイズ / 前面順 / drag handoff / 昇格済みかどうか) の管理は
 * floating-window の `createFloatingWindows` に委譲する (サイズ受け渡しと handoff の契約は
 * そちらの doc 参照)。undock 直後は in-app パネルで、promote で別 OS ウィンドウへ昇格する
 * (presentation の切り替えは UndockedWindow が担う)。
 */
import { createFloatingWindows, type FloatingWindowState } from "../floating-window";

interface UndockedLogData {
  kind: "user" | "assistant";
  /** ヘッダ上段: repo 名 (TerminalLeafTitle と同構成)。未解決は空文字で上段ごと省く。 */
  repoName: string;
  /** RepoIcon 用の GitHub owner。空文字は identicon フォールバック。 */
  repoOwner: string;
  /** ヘッダ下段: session タイトル (+ sub 由来は subagent ラベル)。 */
  title: string;
  text: string;
}

export type UndockedLog = UndockedLogData & FloatingWindowState;

const store = createFloatingWindows<UndockedLogData>("undockedLog");

export function useUndockedLog() {
  const { windows, undock, takeHandoff, close, move, bringToFront, promote, demote } = store;
  return { logs: windows, undock, takeHandoff, close, move, bringToFront, promote, demote };
}
