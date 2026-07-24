import type { IMarker } from "@xterm/xterm";
import { describe, expect, spyOn, test } from "bun:test";
import { createCwdTracker, type CwdMarkerHost } from "./cwdTracker";

/** カーソル行を外部から進められる fake terminal。marker の dispose も操作できる */
function createFakeTerminal() {
  let cursorLine = 0;
  const markers: IMarker[] = [];
  const host: CwdMarkerHost = {
    registerMarker: () => {
      const line = cursorLine;
      let disposed = false;
      const listeners: (() => void)[] = [];
      const marker: IMarker = {
        id: markers.length,
        get line() {
          return line;
        },
        get isDisposed() {
          return disposed;
        },
        dispose: () => {
          if (disposed) return;
          disposed = true;
          for (const listener of listeners) listener();
        },
        onDispose: (listener) => {
          listeners.push(() => listener());
          return { dispose: () => {} };
        },
      };
      markers.push(marker);
      return marker;
    },
  };
  return {
    host,
    markers,
    moveCursorTo: (line: number) => {
      cursorLine = line;
    },
  };
}

describe("createCwdTracker", () => {
  test("遷移がなければ undefined（worktree root fallback）", () => {
    const { host } = createFakeTerminal();
    const tracker = createCwdTracker(host);
    expect(tracker.cwdAtLine(0)).toBeUndefined();
  });

  test("遷移以降の行はその cwd を返す", () => {
    const { host } = createFakeTerminal();
    const tracker = createCwdTracker(host);
    tracker.observe("/repo");
    expect(tracker.cwdAtLine(0)).toBe("/repo");
    expect(tracker.cwdAtLine(100)).toBe("/repo");
  });

  test("最初の遷移より前の行は undefined を返す", () => {
    const { host, moveCursorTo } = createFakeTerminal();
    const tracker = createCwdTracker(host);
    moveCursorTo(10);
    tracker.observe("/repo");
    expect(tracker.cwdAtLine(9)).toBeUndefined();
    expect(tracker.cwdAtLine(10)).toBe("/repo");
  });

  test("複数遷移は行位置で出力時点の cwd に振り分ける", () => {
    const { host, moveCursorTo } = createFakeTerminal();
    const tracker = createCwdTracker(host);
    tracker.observe("/repo");
    moveCursorTo(10);
    tracker.observe("/repo/apps/renderer");
    expect(tracker.cwdAtLine(5)).toBe("/repo");
    expect(tracker.cwdAtLine(9)).toBe("/repo");
    expect(tracker.cwdAtLine(10)).toBe("/repo/apps/renderer");
    expect(tracker.cwdAtLine(50)).toBe("/repo/apps/renderer");
  });

  test("同一 cwd の連続通知は遷移を増やさない", () => {
    const { host, markers, moveCursorTo } = createFakeTerminal();
    const tracker = createCwdTracker(host);
    tracker.observe("/repo");
    moveCursorTo(10);
    tracker.observe("/repo");
    expect(markers.length).toBe(1);
  });

  test("trim で最古の遷移が消えたら cwd を baseline へ昇格する", () => {
    const { host, markers, moveCursorTo } = createFakeTerminal();
    const tracker = createCwdTracker(host);
    tracker.observe("/repo");
    moveCursorTo(10);
    tracker.observe("/repo/sub");
    const [first] = markers;
    first?.dispose();
    // 消えた遷移の cwd がバッファ先頭からの適用値になる
    expect(tracker.cwdAtLine(0)).toBe("/repo");
    expect(tracker.cwdAtLine(10)).toBe("/repo/sub");
  });

  test("reflow 由来の中間 dispose は baseline と他の帰属を壊さない", () => {
    const { host, markers, moveCursorTo } = createFakeTerminal();
    const tracker = createCwdTracker(host);
    moveCursorTo(10);
    tracker.observe("/repo");
    moveCursorTo(20);
    tracker.observe("/repo/a");
    moveCursorTo(30);
    tracker.observe("/repo/b");
    const [, middle] = markers;
    middle?.dispose();
    // baseline は汚染されない（最初の遷移より前は undefined のまま）
    expect(tracker.cwdAtLine(5)).toBeUndefined();
    // 消えた中間遷移の領域は直前の遷移の cwd に縮退し、他の帰属は保たれる
    expect(tracker.cwdAtLine(10)).toBe("/repo");
    expect(tracker.cwdAtLine(25)).toBe("/repo");
    expect(tracker.cwdAtLine(30)).toBe("/repo/b");
  });

  test("registerMarker 失敗時は全行適用の近似に倒し、縮退ログを出す", () => {
    // 縮退時の観察ログはこの経路の契約。spy で出力を吸いつつ発火まで検証する
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const host: CwdMarkerHost = { registerMarker: () => undefined };
    const tracker = createCwdTracker(host);
    tracker.observe("/repo");
    expect(tracker.cwdAtLine(0)).toBe("/repo");
    expect(tracker.cwdAtLine(100)).toBe("/repo");
    expect(errorSpy).toHaveBeenCalledWith(
      "[cwdTracker] registerMarker failed, degrading to baseline cwd=/repo",
    );
    errorSpy.mockRestore();
  });
});
