/**
 * terminal preview の全文 popover から切り離し (undock) されたメッセージ群の module singleton。
 *
 * undocked window は表示中の repo / session / terminal と独立して存在し続けるため、
 * component ローカルではなく module singleton に置く (`useSessionLogViewer` と同パターン)。
 * 内容は undock 時点の発言のスナップショットで、元セッションのログ参照や
 * watch ライフサイクルには乗らない。元の popover が閉じても消えない独立性が要件のため、
 * ライブ更新はしない。
 *
 * ウィンドウ状態 (位置 / 初期中身サイズ / drag handoff / 昇格済みかどうか) の管理は
 * floating-window の `createFloatingWindows` に委譲する (サイズ受け渡しと handoff の契約は
 * そちらの doc 参照)。undock 直後は in-app パネルで、promote で別 OS ウィンドウへ昇格する
 * (presentation の切り替えは UndockedWindow が担う)。
 */
import type { RepoWorktree } from "../../shared/repo";
import { createFloatingWindows, type FloatingWindowState } from "../floating-window";
import type { SpeechSpeaker } from "./sessionLogView";

/** undock 時点の worktree の写し。表示に要るフィールドだけを持ち、以後の変化に追従しない */
type UndockedLogWorktree = Pick<
  RepoWorktree,
  "branch" | "path" | "head" | "detached" | "listUnavailable"
>;

interface UndockedLogData {
  speaker: SpeechSpeaker;
  /** ヘッダ上段: repo 名。未解決は空文字で上段ごと省く。 */
  repoName: string;
  /** RepoIcon 用の GitHub owner。空文字は identicon フォールバック。 */
  repoOwner: string;
  /** ヘッダ上段で repo 名の横に出す worktree。未解決は undefined で省く。 */
  worktree: UndockedLogWorktree | undefined;
  /** ヘッダ下段: session タイトル (+ sub 由来は subagent ラベル)。 */
  title: string;
  text: string;
  /** 本文の先頭に出す印 (`speechMark`) */
  mark: string | undefined;
}

export type UndockedLog = UndockedLogData & FloatingWindowState;

const store = createFloatingWindows<UndockedLogData>("undockedLog");

export function useUndockedLog() {
  const { windows, undock, takeHandoff, close, move, promote, demote } = store;
  return { logs: windows, undock, takeHandoff, close, move, promote, demote };
}
