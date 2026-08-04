// 配信 root は main が読めるファイルの範囲になるため、広がり方を固定する。
import { describe, expect, test } from "bun:test";
import { htmlPreviewTarget } from "./htmlPreviewTarget";

describe("htmlPreviewTarget", () => {
  test("worktree 起点は worktree root を配信範囲にする", () => {
    expect(htmlPreviewTarget("/repo/docs/a.html", "/repo")).toEqual({
      absPath: "/repo/docs/a.html",
      root: "/repo",
    });
  });

  test("worktree 外はファイルが居る dir だけに絞る", () => {
    expect(htmlPreviewTarget("/tmp/notes/a.html", undefined)).toEqual({
      absPath: "/tmp/notes/a.html",
      root: "/tmp/notes",
    });
  });

  test("root 直下のファイルは / を root にする", () => {
    expect(htmlPreviewTarget("/a.html", undefined)).toEqual({ absPath: "/a.html", root: "/" });
  });
});
