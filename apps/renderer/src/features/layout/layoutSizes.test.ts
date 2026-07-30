import { MIN_WINDOW_WIDTH, TITLEBAR_HEIGHT } from "@gozd/shared";
import { describe, expect, it } from "bun:test";
import {
  centerColumnWidth,
  fitColumnWidths,
  fitGitGraphHeight,
  fitPreviewWidth,
  GIT_GRAPH_MIN_HEIGHT,
  HANDLE_WIDTH,
  NAVIGATOR_MIN_WIDTH,
  PREVIEW_MIN_WIDTH,
  previewBeforeMinWidth,
  SIDEBAR_MIN_WIDTH,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_MIN_WIDTH,
} from "./layoutSizes";

const DESIRED = { sidebar: 260, navigator: 256 };
const MIN_COLUMNS = { sidebar: SIDEBAR_MIN_WIDTH, navigator: NAVIGATOR_MIN_WIDTH };

/** 中央カラムへの予約幅（Preview 非表示時 / 表示時） */
const CLOSED = TERMINAL_MIN_WIDTH;
const OPEN = TERMINAL_MIN_WIDTH + PREVIEW_MIN_WIDTH;

describe("fitColumnWidths", () => {
  it("十分な幅では希望幅をそのまま返す", () => {
    expect(fitColumnWidths(1280, DESIRED, CLOSED)).toEqual(DESIRED);
  });

  it("溢れる分は Navigator から削る", () => {
    expect(fitColumnWidths(700, DESIRED, CLOSED)).toEqual({ sidebar: 260, navigator: 224 });
  });

  it("Navigator が最小に達したら Sidebar を削る", () => {
    expect(fitColumnWidths(600, DESIRED, CLOSED)).toEqual({
      sidebar: 204,
      navigator: NAVIGATOR_MIN_WIDTH,
    });
  });

  it("両方が最小でも入らないウィンドウでは最小幅を返す", () => {
    expect(fitColumnWidths(300, DESIRED, CLOSED)).toEqual(MIN_COLUMNS);
  });

  it("希望幅が最小を下回っても最小幅まで戻す", () => {
    expect(fitColumnWidths(1280, { sidebar: 10, navigator: 10 }, CLOSED)).toEqual(MIN_COLUMNS);
  });

  it("予約幅が増えると列幅が譲る（希望幅に余裕がある分は先に消費される）", () => {
    const closed = fitColumnWidths(900, DESIRED, CLOSED);
    const open = fitColumnWidths(900, DESIRED, OPEN);
    expect(closed).toEqual(DESIRED);
    expect(open.sidebar + open.navigator).toBeLessThan(closed.sidebar + closed.navigator);
  });
});

describe("centerColumnWidth", () => {
  it("列幅とハンドル 2 本を引いた残余を返す", () => {
    expect(centerColumnWidth(1280, DESIRED)).toBe(1280 - 260 - 256 - HANDLE_WIDTH * 2);
  });

  it("最小列幅が入らないウィンドウでは負値を返す（下限で覆い隠さない）", () => {
    expect(centerColumnWidth(300, MIN_COLUMNS)).toBeLessThan(0);
  });

  it("下限以上のウィンドウでは予約幅を確保する", () => {
    for (const windowWidth of [MIN_WINDOW_WIDTH, 800, 1280, 2560]) {
      for (const reserved of [CLOSED, OPEN]) {
        const columns = fitColumnWidths(windowWidth, DESIRED, reserved);
        expect(centerColumnWidth(windowWidth, columns)).toBeGreaterThanOrEqual(reserved);
      }
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

  it("取り分を予約した列幅では常に最小幅以上で描画される", () => {
    for (const windowWidth of [MIN_WINDOW_WIDTH, 800, 1280, 2560]) {
      const columns = fitColumnWidths(windowWidth, DESIRED, OPEN);
      const centerWidth = centerColumnWidth(windowWidth, columns);
      expect(fitPreviewWidth(PREVIEW_MIN_WIDTH, centerWidth)).toBeGreaterThanOrEqual(
        PREVIEW_MIN_WIDTH,
      );
    }
  });

  it("描画幅は popover が Sidebar のハンドルを覆わない位置に収まる", () => {
    // popover の左端 = Sidebar 右端 + H + 中央カラム描画幅 - Preview 描画幅
    for (const windowWidth of [MIN_WINDOW_WIDTH, 800, 1280, 2560]) {
      const columns = fitColumnWidths(windowWidth, DESIRED, OPEN);
      const centerWidth = centerColumnWidth(windowWidth, columns);
      const popoverLeft =
        columns.sidebar + HANDLE_WIDTH + centerWidth - fitPreviewWidth(1200, centerWidth);
      expect(popoverLeft).toBeGreaterThanOrEqual(previewBeforeMinWidth(columns.sidebar));
    }
  });
});

describe("MIN_WINDOW_WIDTH", () => {
  it("希望列幅に関わらず Preview を最小幅で描画できる下限になっている", () => {
    for (const desired of [MIN_COLUMNS, DESIRED, { sidebar: 800, navigator: 600 }]) {
      const columns = fitColumnWidths(MIN_WINDOW_WIDTH, desired, OPEN);
      const centerWidth = centerColumnWidth(MIN_WINDOW_WIDTH, columns);
      expect(fitPreviewWidth(PREVIEW_MIN_WIDTH, centerWidth)).toBe(PREVIEW_MIN_WIDTH);
    }
  });

  it("1px 狭いと Preview 最小幅を割る（下限が過大でない）", () => {
    const windowWidth = MIN_WINDOW_WIDTH - 1;
    const columns = fitColumnWidths(windowWidth, MIN_COLUMNS, OPEN);
    const centerWidth = centerColumnWidth(windowWidth, columns);
    expect(fitPreviewWidth(PREVIEW_MIN_WIDTH, centerWidth)).toBeLessThan(PREVIEW_MIN_WIDTH);
  });
});

describe("fitGitGraphHeight", () => {
  it("Terminal の最小高が残る範囲では希望高をそのまま返す", () => {
    expect(fitGitGraphHeight(128, 800)).toBe(128);
  });

  it("Terminal の最小高を残す高さで切る", () => {
    const windowHeight = 300;
    expect(fitGitGraphHeight(500, windowHeight)).toBe(
      windowHeight - TITLEBAR_HEIGHT - TERMINAL_MIN_HEIGHT - HANDLE_WIDTH,
    );
  });

  it("Terminal の最小高すら入らない高さでは 0 を返す", () => {
    expect(fitGitGraphHeight(128, TITLEBAR_HEIGHT + TERMINAL_MIN_HEIGHT)).toBe(0);
  });

  it("希望高は破壊しないため、ウィンドウ高が戻れば元の高さに復元する", () => {
    const desired = 300;
    expect(fitGitGraphHeight(desired, 400)).toBeLessThan(desired);
    expect(fitGitGraphHeight(desired, 800)).toBe(desired);
  });

  it("drag の下限は描画に使わない（GitGraph は 0 まで潰れる）", () => {
    expect(fitGitGraphHeight(GIT_GRAPH_MIN_HEIGHT, 100)).toBe(0);
  });
});
