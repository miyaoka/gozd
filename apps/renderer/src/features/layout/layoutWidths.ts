// 横並びレイアウト（Sidebar | H | 中央カラム | H | Navigator）の幅ポリシー。
// Preview popover の被覆境界が中央カラムの幅で決まるため、算術を SFC から分離して
// 境界（popover が Sidebar のハンドルへ食い込む幅 / Terminal が最小幅を割る幅）を
// テストできる形にする。

/** リサイズハンドルの幅（ResizeHandle の `w-2`） */
export const HANDLE_WIDTH = 8;

export const SIDEBAR_MIN_WIDTH = 120;
export const NAVIGATOR_MIN_WIDTH = 180;
export const TERMINAL_MIN_WIDTH = 200;
export const PREVIEW_MIN_WIDTH = 200;

export interface ColumnWidths {
  sidebar: number;
  navigator: number;
}

/** 下限優先の clamp。max < min（列幅が入らないウィンドウ）では min を返す */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * 希望列幅をウィンドウ幅に収めた描画幅。
 *
 * ref が持つのはユーザーの希望幅で、描画はこの派生値を使う。ウィンドウ縮小のたびに ref を
 * 書き戻すと希望幅が失われ、ウィンドウを戻しても元の幅に復元できない。
 *
 * 溢れ分は Navigator → Sidebar の順に min まで削る。Sidebar は worktree 切替の主導線で、
 * 潰れると worktree 名が読めず操作の起点そのものを失うため最後に削る。
 */
export function fitColumnWidths(windowWidth: number, desired: ColumnWidths): ColumnWidths {
  const available = windowWidth - HANDLE_WIDTH * 2 - TERMINAL_MIN_WIDTH;
  const sidebar = clamp(desired.sidebar, SIDEBAR_MIN_WIDTH, available - NAVIGATOR_MIN_WIDTH);
  const navigator = clamp(desired.navigator, NAVIGATOR_MIN_WIDTH, available - sidebar);
  return { sidebar, navigator };
}

/** 中央カラム（Terminal + GitGraph）の描画幅。columns は `fitColumnWidths` を通した値 */
export function centerColumnWidth(windowWidth: number, columns: ColumnWidths): number {
  return Math.max(
    TERMINAL_MIN_WIDTH,
    windowWidth - columns.sidebar - columns.navigator - HANDLE_WIDTH * 2,
  );
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

/** Preview popover 幅の上限（中央カラムに Terminal の最小幅を残す） */
function maxPreviewWidth(centerWidth: number): number {
  return Math.max(0, centerWidth - TERMINAL_MIN_WIDTH);
}

/**
 * Preview popover の描画幅。希望幅を上限で切るだけで、下限では押し戻さない。
 *
 * `PREVIEW_MIN_WIDTH` は drag が縮められる下限であり、幾何的に入らない幅の捏造には使わない。
 * 上限を超える値を描画に流すと popover が Sidebar のハンドルへ食い込む。
 */
export function fitPreviewWidth(desiredWidth: number, centerWidth: number): number {
  return Math.min(desiredWidth, maxPreviewWidth(centerWidth));
}
