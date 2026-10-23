// 配信 root は main が読めるファイルの範囲になるため、広がり方を固定する。
import { describe, expect, test } from "bun:test";
import { previewServingTarget } from "./previewServingTarget";

describe("previewServingTarget", () => {
  test("worktree 起点は worktree root を配信範囲にする", () => {
    expect(previewServingTarget("/repo/docs/a.html", "/repo")).toEqual({
      absPath: "/repo/docs/a.html",
      root: "/repo",
    });
  });

  test("worktree 外はファイルが居る dir だけに絞る", () => {
    expect(previewServingTarget("/tmp/notes/a.html", undefined)).toEqual({
      absPath: "/tmp/notes/a.html",
      root: "/tmp/notes",
    });
  });

  test("root が / に退化する場合は native preview を諦める", () => {
    // ファイルシステム全体が配信可能になるのを防ぐ。登録は取り消せないため未然に切る
    expect(previewServingTarget("/a.html", undefined)).toBeUndefined();
    expect(previewServingTarget("/repo/docs/a.html", "/")).toBeUndefined();
  });
});
