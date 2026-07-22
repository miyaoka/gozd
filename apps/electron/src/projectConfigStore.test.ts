import { describe, expect, test } from "bun:test";
import { normalizeProjectConfig } from "./projectConfigStore";

describe("normalizeProjectConfig (lenient)", () => {
  test("欠落フィールドは default 充填する", () => {
    expect(normalizeProjectConfig({})).toEqual({ worktreeSymlinks: [], setupScript: "" });
  });

  test("型違反フィールドは default に倒す（throw しない）", () => {
    const config = normalizeProjectConfig({ worktreeSymlinks: "not-array", setupScript: 5 });
    expect(config).toEqual({ worktreeSymlinks: [], setupScript: "" });
  });

  test("worktreeSymlinks の非文字列要素だけ落とす", () => {
    const config = normalizeProjectConfig({ worktreeSymlinks: [".claude", 1, ".env.local"] });
    expect(config.worktreeSymlinks).toEqual([".claude", ".env.local"]);
  });
});
