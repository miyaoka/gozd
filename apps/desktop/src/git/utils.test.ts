import { describe, expect, test } from "bun:test";
import { parseOwnerRepo } from "./utils";

describe("parseOwnerRepo", () => {
  test("HTTPS URL から owner/repo を抽出する", () => {
    expect(parseOwnerRepo("https://github.com/miyaoka/gozd")).toBe("miyaoka/gozd");
  });

  test("HTTPS URL (.git 付き) から owner/repo を抽出する", () => {
    expect(parseOwnerRepo("https://github.com/miyaoka/gozd.git")).toBe("miyaoka/gozd");
  });

  test("SSH URL から owner/repo を抽出する", () => {
    expect(parseOwnerRepo("git@github.com:miyaoka/gozd.git")).toBe("miyaoka/gozd");
  });

  test("SSH URL (.git なし) から owner/repo を抽出する", () => {
    expect(parseOwnerRepo("git@github.com:miyaoka/gozd")).toBe("miyaoka/gozd");
  });

  test("ssh:// プロトコルから owner/repo を抽出する", () => {
    expect(parseOwnerRepo("ssh://git@bitbucket.org/team/repo.git")).toBe("team/repo");
  });

  test("GitLab の HTTPS URL から owner/repo を抽出する", () => {
    expect(parseOwnerRepo("https://gitlab.com/org/project.git")).toBe("org/project");
  });

  test("file:// URL は undefined を返す", () => {
    expect(parseOwnerRepo("file:///home/me/repo.git")).toBeUndefined();
  });

  test("絶対パスは undefined を返す", () => {
    expect(parseOwnerRepo("/Users/foo/bar/repo.git")).toBeUndefined();
  });

  test("空文字は undefined を返す", () => {
    expect(parseOwnerRepo("")).toBeUndefined();
  });
});
