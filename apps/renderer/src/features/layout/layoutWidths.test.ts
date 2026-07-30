import { MIN_WINDOW_WIDTH } from "@gozd/shared";
import { describe, expect, it } from "bun:test";
import {
  centerColumnWidth,
  fitColumnWidths,
  fitPreviewWidth,
  HANDLE_WIDTH,
  NAVIGATOR_MIN_WIDTH,
  PREVIEW_MIN_WIDTH,
  previewBeforeMinWidth,
  SIDEBAR_MIN_WIDTH,
  TERMINAL_MIN_WIDTH,
} from "./layoutWidths";

const DEFAULT_COLUMNS = { sidebar: 260, navigator: 256 };

describe("fitColumnWidths", () => {
  it("十分な幅では希望幅をそのまま返す", () => {
    expect(fitColumnWidths(1280, DEFAULT_COLUMNS)).toEqual(DEFAULT_COLUMNS);
  });

  it("溢れる分は Navigator から削る", () => {
    expect(fitColumnWidths(700, DEFAULT_COLUMNS)).toEqual({ sidebar: 260, navigator: 224 });
  });

  it("Navigator が最小に達したら Sidebar を削る", () => {
    const fitted = fitColumnWidths(600, DEFAULT_COLUMNS);
    expect(fitted).toEqual({ sidebar: 204, navigator: NAVIGATOR_MIN_WIDTH });
  });

  it("両方が最小でも入らないウィンドウでは最小幅を返す", () => {
    expect(fitColumnWidths(300, DEFAULT_COLUMNS)).toEqual({
      sidebar: SIDEBAR_MIN_WIDTH,
      navigator: NAVIGATOR_MIN_WIDTH,
    });
  });

  it("希望幅が最小を下回っても最小幅まで戻す", () => {
    expect(fitColumnWidths(1280, { sidebar: 10, navigator: 10 })).toEqual({
      sidebar: SIDEBAR_MIN_WIDTH,
      navigator: NAVIGATOR_MIN_WIDTH,
    });
  });
});

describe("centerColumnWidth", () => {
  it("列幅とハンドル 2 本を引いた残余を返す", () => {
    expect(centerColumnWidth(1280, DEFAULT_COLUMNS)).toBe(1280 - 260 - 256 - HANDLE_WIDTH * 2);
  });

  it("fitColumnWidths を通した列幅なら Terminal 最小幅を下回らない", () => {
    for (const windowWidth of [MIN_WINDOW_WIDTH, 700, 600, 520, 300]) {
      const columns = fitColumnWidths(windowWidth, DEFAULT_COLUMNS);
      expect(centerColumnWidth(windowWidth, columns)).toBeGreaterThanOrEqual(TERMINAL_MIN_WIDTH);
    }
  });
});

describe("fitPreviewWidth", () => {
  it("上限内の希望幅はそのまま通す", () => {
    expect(fitPreviewWidth(400, 1000)).toBe(400);
  });

  it("中央カラムに Terminal 最小幅を残す幅で切る", () => {
    expect(fitPreviewWidth(1200, 1000)).toBe(1000 - TERMINAL_MIN_WIDTH);
  });

  it("Terminal 最小幅しか無い中央カラムでは 0 を返す（下限で押し戻さない）", () => {
    expect(fitPreviewWidth(1200, TERMINAL_MIN_WIDTH)).toBe(0);
  });

  it("希望幅は破壊しないため、中央カラムが戻れば元の幅に復元する", () => {
    const desired = 1200;
    expect(fitPreviewWidth(desired, TERMINAL_MIN_WIDTH)).toBe(0);
    expect(fitPreviewWidth(desired, 2000)).toBe(desired);
  });

  it("描画幅は popover が Sidebar のハンドルを覆わない位置に収まる", () => {
    // popover の左端 = Sidebar 右端 + H + Terminal 描画幅 - preview 描画幅
    for (const windowWidth of [MIN_WINDOW_WIDTH, 800, 1280, 2560]) {
      const columns = fitColumnWidths(windowWidth, DEFAULT_COLUMNS);
      const centerWidth = centerColumnWidth(windowWidth, columns);
      const popoverLeft =
        columns.sidebar + HANDLE_WIDTH + centerWidth - fitPreviewWidth(1200, centerWidth);
      expect(popoverLeft).toBeGreaterThanOrEqual(previewBeforeMinWidth(columns.sidebar));
    }
  });
});

describe("MIN_WINDOW_WIDTH", () => {
  it("最小列幅で Preview 最小幅を描画できる下限になっている", () => {
    const columns = fitColumnWidths(MIN_WINDOW_WIDTH, {
      sidebar: SIDEBAR_MIN_WIDTH,
      navigator: NAVIGATOR_MIN_WIDTH,
    });
    const centerWidth = centerColumnWidth(MIN_WINDOW_WIDTH, columns);
    expect(fitPreviewWidth(PREVIEW_MIN_WIDTH, centerWidth)).toBe(PREVIEW_MIN_WIDTH);
  });

  it("1px 狭いと Preview 最小幅を割る（下限が過大でない）", () => {
    const windowWidth = MIN_WINDOW_WIDTH - 1;
    const columns = fitColumnWidths(windowWidth, {
      sidebar: SIDEBAR_MIN_WIDTH,
      navigator: NAVIGATOR_MIN_WIDTH,
    });
    const centerWidth = centerColumnWidth(windowWidth, columns);
    expect(fitPreviewWidth(PREVIEW_MIN_WIDTH, centerWidth)).toBeLessThan(PREVIEW_MIN_WIDTH);
  });
});
