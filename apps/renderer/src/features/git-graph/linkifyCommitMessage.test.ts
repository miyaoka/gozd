import { describe, expect, test } from "bun:test";
import { buildRepoBaseUrl, linkifyCommitMessage } from "./linkifyCommitMessage";

describe("buildRepoBaseUrl", () => {
  test("builds base URL from (owner, repo) identity", () => {
    expect(buildRepoBaseUrl({ owner: "miyaoka", repo: "gozd" })).toBe(
      "https://github.com/miyaoka/gozd",
    );
  });

  test("returns undefined when identity is undefined", () => {
    expect(buildRepoBaseUrl(undefined)).toBeUndefined();
  });

  test("returns undefined when owner is empty (remote unset / non-github host)", () => {
    expect(buildRepoBaseUrl({ owner: "", repo: "gozd" })).toBeUndefined();
  });

  test("returns undefined when repo is empty (remote unset / non-github host)", () => {
    expect(buildRepoBaseUrl({ owner: "miyaoka", repo: "" })).toBeUndefined();
  });

  test("returns undefined when both empty", () => {
    expect(buildRepoBaseUrl({ owner: "", repo: "" })).toBeUndefined();
  });
});

describe("linkifyCommitMessage", () => {
  const base = "https://github.com/miyaoka/gozd";

  test("no baseUrl returns plain text segment", () => {
    expect(linkifyCommitMessage("Fix #123 bug", undefined)).toEqual([
      { type: "text", value: "Fix #123 bug" },
    ]);
  });

  test("linkifies a single issue reference", () => {
    expect(linkifyCommitMessage("Fix #123 bug", base)).toEqual([
      { type: "text", value: "Fix " },
      { type: "issue", value: "#123", href: `${base}/issues/123` },
      { type: "text", value: " bug" },
    ]);
  });

  test("linkifies merge commit subject", () => {
    const result = linkifyCommitMessage("Merge pull request #561 from miyaoka/docs", base);
    expect(result).toEqual([
      { type: "text", value: "Merge pull request " },
      { type: "issue", value: "#561", href: `${base}/issues/561` },
      { type: "text", value: " from miyaoka/docs" },
    ]);
  });

  test("linkifies multiple references", () => {
    const result = linkifyCommitMessage("Closes #1 and #22", base);
    expect(result).toEqual([
      { type: "text", value: "Closes " },
      { type: "issue", value: "#1", href: `${base}/issues/1` },
      { type: "text", value: " and " },
      { type: "issue", value: "#22", href: `${base}/issues/22` },
    ]);
  });

  test("does not linkify HTML entity-like sequences", () => {
    expect(linkifyCommitMessage("foo &#123; bar", base)).toEqual([
      { type: "text", value: "foo &#123; bar" },
    ]);
  });

  test("does not linkify hash inside a word boundary", () => {
    // `foo#456` looks like a fragment / disambiguator, not a GitHub issue reference.
    expect(linkifyCommitMessage("foo#456 bar", base)).toEqual([
      { type: "text", value: "foo#456 bar" },
    ]);
  });

  test("linkifies reference at start of string", () => {
    expect(linkifyCommitMessage("#42 done", base)).toEqual([
      { type: "issue", value: "#42", href: `${base}/issues/42` },
      { type: "text", value: " done" },
    ]);
  });

  test("linkifies reference at end of string", () => {
    expect(linkifyCommitMessage("see #99", base)).toEqual([
      { type: "text", value: "see " },
      { type: "issue", value: "#99", href: `${base}/issues/99` },
    ]);
  });

  test("empty message returns single empty text segment", () => {
    expect(linkifyCommitMessage("", base)).toEqual([{ type: "text", value: "" }]);
  });

  test("linkifies #0 even though GitHub has no issue #0 (regex contract)", () => {
    expect(linkifyCommitMessage("regress #0", base)).toEqual([
      { type: "text", value: "regress " },
      { type: "issue", value: "#0", href: `${base}/issues/0` },
    ]);
  });

  test("linkifies the second `#` in `##123` (regex contract)", () => {
    expect(linkifyCommitMessage("see ##123 note", base)).toEqual([
      { type: "text", value: "see #" },
      { type: "issue", value: "#123", href: `${base}/issues/123` },
      { type: "text", value: " note" },
    ]);
  });

  test("does not linkify `# 123` (whitespace between hash and digits)", () => {
    expect(linkifyCommitMessage("note # 123 ok", base)).toEqual([
      { type: "text", value: "note # 123 ok" },
    ]);
  });

  test("does not linkify `#1a2` (digits trailed by letters)", () => {
    expect(linkifyCommitMessage("v #1a2 ok", base)).toEqual([{ type: "text", value: "v #1a2 ok" }]);
  });

  // `buildRepoBaseUrl` -> `linkifyCommitMessage` の暗黙契約 (= 末尾スラッシュ無し absolute URL) を
  // 統合テストで縛る。`buildRepoBaseUrl` が将来「末尾スラッシュ付き」「`.git` 付き」等を
  // 返すように変更されると `//issues/N` / `.git/issues/N` のような壊れたパスになり、
  // 単体テストでは検知できないため。
  test("integration: buildRepoBaseUrl output is consumable by linkifyCommitMessage", () => {
    const baseFromBuild = buildRepoBaseUrl({ owner: "miyaoka", repo: "gozd" });
    expect(linkifyCommitMessage("Fix #123", baseFromBuild)).toEqual([
      { type: "text", value: "Fix " },
      { type: "issue", value: "#123", href: "https://github.com/miyaoka/gozd/issues/123" },
    ]);
  });
});
