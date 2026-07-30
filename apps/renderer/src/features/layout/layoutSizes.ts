// MainLayout のペインサイズポリシー。
//
// ref が持つのはユーザーがドラッグで決めた希望サイズで、描画はここを通した派生値を使う。
// Preview popover の被覆境界が中央カラムの幅で決まるため、算術を SFC から分離して境界
// （popover が Sidebar のハンドルへ食い込む幅 / Preview の描画幅が 0 に潰れる幅）を
// テストできる形にする。

import { TITLEBAR_HEIGHT } from "@gozd/shared";

/** リサイズハンドルの幅・高さ（ResizeHandle の `w-2` / `h-2`） */
export const HANDLE_WIDTH = 8;

export const SIDEBAR_MIN_WIDTH = 120;
export const NAVIGATOR_MIN_WIDTH = 180;
export const TERMINAL_MIN_WIDTH = 200;
export const PREVIEW_MIN_WIDTH = 200;
export const TERMINAL_MIN_HEIGHT = 150;
export const GIT_GRAPH_MIN_HEIGHT = 40;

export interface ColumnWidths {
  sidebar: number;
  navigator: number;
}

/** 下限優先の clamp。max < min（サイズが入らないウィンドウ）では min を返す */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * 希望列幅をウィンドウ幅に収めた描画幅。
 *
 * `reservedCenterWidth` は中央カラムに残す幅で、Preview 表示中は Preview の取り分も含める
 * （含めないと列幅が Terminal 最小幅まで詰められた時点で Preview の描画幅が 0 になる）。
 *
 * 溢れ分は Navigator → Sidebar の順に min まで削る。Sidebar は worktree 切替の主導線で、
 * 潰れると worktree 名が読めず操作の起点そのものを失うため最後に削る。
 */
export function fitColumnWidths(
  windowWidth: number,
  desired: ColumnWidths,
  reservedCenterWidth: number,
): ColumnWidths {
  const available = windowWidth - HANDLE_WIDTH * 2 - reservedCenterWidth;
  const sidebar = clamp(desired.sidebar, SIDEBAR_MIN_WIDTH, available - NAVIGATOR_MIN_WIDTH);
  const navigator = clamp(desired.navigator, NAVIGATOR_MIN_WIDTH, available - sidebar);
  return { sidebar, navigator };
}

/**
 * 中央カラム（Terminal + GitGraph）の描画幅。columns は `fitColumnWidths` を通した値。
 *
 * 最小列幅すら入らないウィンドウでは負値を返す。行が `overflow-hidden` で溢れる退化状態を
 * 下限で覆い隠すと、実レイアウトに存在しない幅が drag の起点や TerminalPane へ流れる
 * （到達を防ぐのはウィンドウ側の `MIN_WINDOW_WIDTH`）。
 */
export function centerColumnWidth(windowWidth: number, columns: ColumnWidths): number {
  return windowWidth - columns.sidebar - columns.navigator - HANDLE_WIDTH * 2;
}

/**
 * Preview popover の左に必ず残す幅。
 *
 * popover は中央カラムの右端から左へ伸びるため、これ以上左へ伸ばすと Sidebar の
 * リサイズハンドルを覆って掴めなくなる。
 */
export function previewBeforeMinWidth(sidebarWidth: number): number {
  return sidebarWidth + HANDLE_WIDTH + TERMINAL_MIN_WIDTH;
}

/**
 * Preview popover の描画幅。希望幅を上限で切るだけで、下限では押し戻さない。
 *
 * `PREVIEW_MIN_WIDTH` は drag が縮められる下限であり、幾何的に入らない幅の捏造には使わない。
 * 上限を超える値を描画に流すと popover が Sidebar のハンドルへ食い込む。Preview 表示中の
 * 上限が最小幅を下回らないことは `fitColumnWidths` の取り分予約が保証する。
 */
export function fitPreviewWidth(desiredWidth: number, centerWidth: number): number {
  return Math.min(desiredWidth, Math.max(0, centerWidth - TERMINAL_MIN_WIDTH));
}

/**
 * GitGraph ペインの描画高さ。中央カラムに Terminal の最小高を残す。
 *
 * 幅と同じ規律で、縮小時に希望高を ref へ書き戻さない（書き戻すと縦に狭めて戻したときに
 * 元の高さへ復元できない）。
 */
export function fitGitGraphHeight(desiredHeight: number, windowHeight: number): number {
  const available = windowHeight - TITLEBAR_HEIGHT - TERMINAL_MIN_HEIGHT - HANDLE_WIDTH;
  return Math.max(0, Math.min(desiredHeight, available));
}
