/**
 * terminal preview の全文 popover から切り離し (undock) されたメッセージ群の module singleton。
 *
 * undocked window は表示中の repo / session / terminal と独立して存在し続けるため、
 * component ローカルではなく module singleton に置く (`useSessionLogViewer` と同パターン)。
 * 内容は undock 時点のスナップショット (kind + text) で、元セッションのログ参照や
 * watch ライフサイクルには乗らない。元の popover が閉じても消えない独立性が要件のため、
 * ライブ更新はしない。
 *
 * ウィンドウの実体は別 OS ウィンドウ (floating-window の ChildWindow)。状態管理は
 * `createChildWindows` に委譲し、ここが持つのは snapshot payload の型定義だけ
 * (生成パラメータと handoff の契約は factory の doc 参照)。
 *
 * ChildWindowInit.height には本文 (スクロール面) の高さを渡す。総高さは UndockedLogWindow が
 * mount 時に自分のヘッダ実測高を足して決める (旧 FloatingWindow と同じ本文基準の受け渡し。
 * 総高さを引き継ぐと undock 元とウィンドウのヘッダ高の差分だけ本文が食われるため)。
 */
import { type ChildWindowInit, createChildWindows } from "../floating-window";

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

export type UndockedLog = UndockedLogData & ChildWindowInit & { id: number };

const store = createChildWindows<UndockedLogData>();

export function useUndockedLog() {
  const { windows, undock, takeHandoff, close } = store;
  return { logs: windows, undock, takeHandoff, close };
}
