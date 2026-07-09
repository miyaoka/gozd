import { describe, expect, test } from "bun:test";
import { parseOpenArgs } from "./useSettingsModal";

describe("parseOpenArgs", () => {
  test("非オブジェクト入力は空オプションに落とす", () => {
    expect(parseOpenArgs(undefined)).toEqual({ tab: undefined, projectDir: undefined });
    expect(parseOpenArgs(null)).toEqual({ tab: undefined, projectDir: undefined });
    expect(parseOpenArgs("project")).toEqual({ tab: undefined, projectDir: undefined });
  });

  test("既知の tab はそのまま、未知値は undefined に落とす", () => {
    expect(parseOpenArgs({ tab: "project" }).tab).toBe("project");
    expect(parseOpenArgs({ tab: "global" }).tab).toBe("global");
    expect(parseOpenArgs({ tab: "unknown" }).tab).toBeUndefined();
    expect(parseOpenArgs({ tab: 1 }).tab).toBeUndefined();
  });

  test("rootDir は非空文字列のみ projectDir に採る", () => {
    expect(parseOpenArgs({ rootDir: "/repo" }).projectDir).toBe("/repo");
    expect(parseOpenArgs({ rootDir: "" }).projectDir).toBeUndefined();
    expect(parseOpenArgs({ rootDir: 123 }).projectDir).toBeUndefined();
  });

  test("repo メニュー相当の引数を tab / projectDir に分解する", () => {
    expect(parseOpenArgs({ tab: "project", rootDir: "/repo" })).toEqual({
      tab: "project",
      projectDir: "/repo",
    });
  });
});
