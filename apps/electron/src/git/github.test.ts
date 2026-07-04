import { describe, expect, test } from "bun:test";
import { parseGitHubOwnerRepo } from "./github";

describe("parseGitHubOwnerRepo", () => {
  test("https 形式", () => {
    expect(parseGitHubOwnerRepo("https://github.com/miyaoka/gozd.git")).toEqual({
      owner: "miyaoka",
      repo: "gozd",
    });
  });

  test("scp 形式", () => {
    expect(parseGitHubOwnerRepo("git@github.com:miyaoka/gozd.git")).toEqual({
      owner: "miyaoka",
      repo: "gozd",
    });
  });

  test("ssh scheme + port", () => {
    expect(parseGitHubOwnerRepo("ssh://git@github.com:22/miyaoka/gozd")).toEqual({
      owner: "miyaoka",
      repo: "gozd",
    });
  });

  test("非 github.com host は reject", () => {
    expect(parseGitHubOwnerRepo("https://gitlab.com/group/project.git")).toBeUndefined();
    expect(parseGitHubOwnerRepo("git@ghe.example.com:org/repo.git")).toBeUndefined();
  });

  test("セグメント数不一致は reject", () => {
    expect(parseGitHubOwnerRepo("https://github.com/onlyowner")).toBeUndefined();
    expect(parseGitHubOwnerRepo("https://github.com/a/b/c")).toBeUndefined();
  });
});
