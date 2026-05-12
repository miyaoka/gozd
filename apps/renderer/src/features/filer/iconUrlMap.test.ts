import { describe, expect, test } from "bun:test";
import { buildIconUrlByName } from "./iconUrlMap";

describe("buildIconUrlByName", () => {
  test("通常の iconPath から basename を抽出して URL を引く", () => {
    const result = buildIconUrlByName(
      {
        "folder-docs": { iconPath: "./../icons/folder-docs.svg" },
      },
      new Map([["folder-docs", "/hashed/folder-docs.svg"]]),
    );
    expect(result.get("folder-docs")).toBe("/hashed/folder-docs.svg");
  });

  test(".clone サフィックス付きの iconPath を解決する（regression: folder-development など）", () => {
    const result = buildIconUrlByName(
      {
        "folder-development": { iconPath: "./../icons/folder-development.clone.svg" },
        "folder-development-open": { iconPath: "./../icons/folder-development-open.clone.svg" },
      },
      new Map([
        ["folder-development.clone", "/hashed/folder-development.clone.svg"],
        ["folder-development-open.clone", "/hashed/folder-development-open.clone.svg"],
      ]),
    );
    expect(result.get("folder-development")).toBe("/hashed/folder-development.clone.svg");
    expect(result.get("folder-development-open")).toBe("/hashed/folder-development-open.clone.svg");
  });

  test("iconPath が .svg で終わらない場合は throw する（material-icon-theme 仕様変更の検知）", () => {
    expect(() =>
      buildIconUrlByName(
        { "folder-foo": { iconPath: "./../icons/folder-foo.svg?v=2" } },
        new Map([["folder-foo", "/hashed/folder-foo.svg"]]),
      ),
    ).toThrow(/cannot extract basename/);
  });

  test("iconPath が指す basename の SVG が無い場合は throw する", () => {
    expect(() =>
      buildIconUrlByName(
        { "folder-missing": { iconPath: "./../icons/folder-missing.svg" } },
        new Map([["folder-other", "/hashed/folder-other.svg"]]),
      ),
    ).toThrow(/SVG.*not found/);
  });
});
