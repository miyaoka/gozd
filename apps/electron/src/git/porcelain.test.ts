import { describe, expect, test } from "bun:test";
import { parsePorcelainV2WithBranch, parseWorktreePorcelain } from "./porcelain";

describe("parseWorktreePorcelain", () => {
  test("main + linked worktree を parse し最初のエントリを main とする", () => {
    const text = [
      "worktree /repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /wt/feature",
      "HEAD bbbb",
      "branch refs/heads/feature",
      "",
    ].join("\n");
    expect(parseWorktreePorcelain(text)).toEqual([
      { path: "/repo", head: "aaaa", branch: "main", isMain: true },
      { path: "/wt/feature", head: "bbbb", branch: "feature", isMain: false },
    ]);
  });

  test("detached HEAD は branch undefined", () => {
    const text = ["worktree /repo", "HEAD aaaa", "detached", ""].join("\n");
    expect(parseWorktreePorcelain(text)[0].branch).toBeUndefined();
  });

  test("prunable エントリは除外される", () => {
    const text = [
      "worktree /repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /wt/gone",
      "HEAD bbbb",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    const result = parseWorktreePorcelain(text);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/repo");
  });
});

describe("parsePorcelainV2WithBranch", () => {
  const NUL = "\0";

  test("branch ヘッダと各エントリ種別を parse する", () => {
    const text =
      [
        "# branch.oid deadbeef",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -1",
        "1 .M N... 100644 100644 100644 aaa bbb modified.txt",
        "? untracked.txt",
      ].join(NUL) + NUL;
    const result = parsePorcelainV2WithBranch(text);
    expect(result.head).toBe("deadbeef");
    expect(result.branchHead).toBe("main");
    expect(result.hasUpstream).toBe(true);
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(1);
    expect(result.statuses).toEqual({ "modified.txt": ".M", "untracked.txt": "??" });
  });

  test("rename エントリは新パスを statuses に、旧パスを renameOldPaths に入れる", () => {
    const text =
      ["1 .M N... 100644 100644 100644 aaa bbb other.txt", "2 R. N... 100644 100644 100644 aaa bbb R100 new.txt", "old.txt"].join(
        NUL,
      ) + NUL;
    const result = parsePorcelainV2WithBranch(text);
    expect(result.statuses["new.txt"]).toBe("R.");
    expect(result.renameOldPaths).toEqual({ "new.txt": "old.txt" });
    // rename の orig_path segment がその後のエントリ解釈を壊さないこと
    expect(result.statuses["other.txt"]).toBe(".M");
  });

  test("スペースを含むパスを保持する", () => {
    const text = "1 .M N... 100644 100644 100644 aaa bbb path with spaces.txt" + NUL;
    expect(parsePorcelainV2WithBranch(text).statuses).toEqual({
      "path with spaces.txt": ".M",
    });
  });

  test("(initial) oid と (detached) head は空文字に正規化する", () => {
    const text = ["# branch.oid (initial)", "# branch.head (detached)"].join(NUL) + NUL;
    const result = parsePorcelainV2WithBranch(text);
    expect(result.head).toBe("");
    expect(result.branchHead).toBe("");
  });

  test("unmerged エントリの XY を拾う", () => {
    const text = "u UU N... 100644 100644 100644 100644 a b c conflicted.txt" + NUL;
    expect(parsePorcelainV2WithBranch(text).statuses).toEqual({ "conflicted.txt": "UU" });
  });

  test("upstream 無しでは hasUpstream=false / ahead=behind=0", () => {
    const text = ["# branch.oid deadbeef", "# branch.head main"].join(NUL) + NUL;
    const result = parsePorcelainV2WithBranch(text);
    expect(result.hasUpstream).toBe(false);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
  });
});
