import { describe, expect, test } from "bun:test";
import { ghErrorLogDetail, ghErrorMessage } from "./ghError";

describe("ghErrorMessage", () => {
  test("操作名と分類の説明を組み合わせる", () => {
    expect(ghErrorMessage("rateLimit", "Failed to load my work")).toBe(
      "Failed to load my work: GitHub API rate limit exhausted",
    );
  });
});

describe("ghErrorLogDetail", () => {
  test("分類と stderr の両方を残す", () => {
    // 分類だけでは other に落ちた失敗を区別できないため、stderr を捨てない
    expect(ghErrorLogDetail("other", "gh: something broke")).toBe("other: gh: something broke");
  });

  test("stderr が空なら分類だけにする", () => {
    // 区切り文字だけが末尾に残る形にしない
    expect(ghErrorLogDetail("unauthenticated", "")).toBe("unauthenticated");
  });
});
