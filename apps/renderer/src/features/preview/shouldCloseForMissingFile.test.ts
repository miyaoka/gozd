import { describe, expect, test } from "bun:test";
import { shouldCloseForMissingFile } from "./shouldCloseForMissingFile";

describe("shouldCloseForMissingFile", () => {
  test("未追跡削除 (current 不在 + HEAD 不在) → 閉じる", () => {
    expect(
      shouldCloseForMissingFile({
        summaryEnabled: false,
        selKind: "worktreeRelative",
        currentNotFound: true,
        originalMissing: true,
      }),
    ).toBe(true);
  });

  test("追跡削除 race (current 不在 + HEAD 在) → 閉じない", () => {
    expect(
      shouldCloseForMissingFile({
        summaryEnabled: false,
        selKind: "worktreeRelative",
        currentNotFound: true,
        originalMissing: false,
      }),
    ).toBe(false);
  });

  test("summary 表示中は閉じない (summary を巻き込まない)", () => {
    expect(
      shouldCloseForMissingFile({
        summaryEnabled: true,
        selKind: "worktreeRelative",
        currentNotFound: true,
        originalMissing: true,
      }),
    ).toBe(false);
  });

  test("worktree 外の絶対パスは対象外で閉じない", () => {
    expect(
      shouldCloseForMissingFile({
        summaryEnabled: false,
        selKind: "absolute",
        currentNotFound: true,
        originalMissing: true,
      }),
    ).toBe(false);
  });

  test("current が在る (notFound でない) なら閉じない", () => {
    expect(
      shouldCloseForMissingFile({
        summaryEnabled: false,
        selKind: "worktreeRelative",
        currentNotFound: false,
        originalMissing: true,
      }),
    ).toBe(false);
  });
});
