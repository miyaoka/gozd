import { describe, expect, test } from "bun:test";
import { toolArgPreview } from "./sessionLogToolArg";

describe("toolArgPreview", () => {
  test("command はフル表示 (パス系でないので縮約しない)", () => {
    expect(toolArgPreview({ command: "git log --oneline" })).toEqual({
      label: "git log --oneline",
      full: "git log --oneline",
    });
  });

  test("file_path は basename に縮約し full はフルパス", () => {
    expect(toolArgPreview({ file_path: "/Users/a/b/SessionLogDialog.vue" })).toEqual({
      label: "SessionLogDialog.vue",
      full: "/Users/a/b/SessionLogDialog.vue",
    });
  });

  test("末尾スラッシュ付きディレクトリは末尾セグメントを採る", () => {
    expect(toolArgPreview({ path: "/a/b/" })).toEqual({ label: "b", full: "/a/b/" });
  });

  test("区切りなしの相対パスはそのまま", () => {
    expect(toolArgPreview({ file_path: "bar.ts" })).toEqual({ label: "bar.ts", full: "bar.ts" });
  });

  test("区切りのみのパスは空にならず元値に倒す", () => {
    expect(toolArgPreview({ file_path: "/" })).toEqual({ label: "/", full: "/" });
    expect(toolArgPreview({ path: "//" })).toEqual({ label: "//", full: "//" });
  });

  test("代表キーの優先順: command が file_path より先", () => {
    expect(toolArgPreview({ file_path: "/a/b.ts", command: "ls" })).toEqual({
      label: "ls",
      full: "ls",
    });
  });

  test("空文字の代表キーはスキップして次の代表キーへ", () => {
    expect(toolArgPreview({ command: "", file_path: "/a/b.ts" })).toEqual({
      label: "b.ts",
      full: "/a/b.ts",
    });
  });

  test("非 string 値はスキップする", () => {
    expect(toolArgPreview({ command: 123 })).toBeUndefined();
  });

  test("代表キーが無ければ undefined", () => {
    expect(toolArgPreview({ foo: "bar" })).toBeUndefined();
  });
});
