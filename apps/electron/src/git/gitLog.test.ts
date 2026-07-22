// gitLog の parser pure test + 実 git repo での統合テスト。
// parseRefs / parseLogRecords の契約は Swift 版 GitOps+Log.swift の parser と対。

import { afterEach, describe, expect, test } from "bun:test";
import { runFixtureGit } from "../testGitFixture";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, parseLogRecords, parseRefs } from "./gitLog";
import { isAllZeroHex, validateRelPath, validateRev } from "./gitValidate";

describe("parseRefs", () => {
  test("HEAD -> branch は独立要素に分解する", () => {
    expect(parseRefs("HEAD -> main, origin/main, tag: v1.0")).toEqual([
      "HEAD",
      "main",
      "origin/main",
      "tag:v1.0",
    ]);
  });

  test("detached HEAD は単独 HEAD 要素", () => {
    expect(parseRefs("HEAD, origin/main")).toEqual(["HEAD", "origin/main"]);
  });

  test("空文字は空配列", () => {
    expect(parseRefs("")).toEqual([]);
  });

  test('ref 名にカンマを含んでも ", " 区切りなら破壊しない', () => {
    expect(parseRefs("foo,bar, main")).toEqual(["foo,bar", "main"]);
  });
});

describe("parseLogRecords", () => {
  const record = (fields: string[]) => `${fields.join("\x1f")}\x1e`;

  test("8 field record を CommitInfo に変換する", () => {
    const text = record([
      "abc123",
      "abc",
      "p1 p2",
      "alice",
      "1700000000",
      "subject",
      "body",
      "HEAD -> main",
    ]);
    expect(parseLogRecords(text)).toEqual([
      {
        hash: "abc123",
        shortHash: "abc",
        parents: ["p1", "p2"],
        author: "alice",
        date: 1700000000,
        message: "subject",
        body: "body",
        refs: ["HEAD", "main"],
        truncatedAbove: false,
      },
    ]);
  });

  test("root commit（parents 空）は空配列", () => {
    const text = record(["abc", "a", "", "alice", "1", "s", "", ""]);
    expect(parseLogRecords(text)[0].parents).toEqual([]);
  });

  test("field 数が 8 でない record は silent skip せず throw する", () => {
    expect(() => parseLogRecords("only\x1ftwo\x1e")).toThrow(/expected 8/);
  });

  test("author date が整数でない record は throw する", () => {
    const text = record(["a", "b", "", "alice", "not-a-date", "s", "", ""]);
    expect(() => parseLogRecords(text)).toThrow(/not an integer/);
  });
});

describe("validateRev / validateRelPath", () => {
  test('空文字 / "HEAD" / hex hash / suffix 付き hash を許可する', () => {
    expect(() => validateRev("")).not.toThrow();
    expect(() => validateRev("HEAD")).not.toThrow();
    expect(() => validateRev("abc123DEF")).not.toThrow();
    expect(() => validateRev("abc123^")).not.toThrow();
    expect(() => validateRev("abc123~2")).not.toThrow();
  });

  test("option 注入 / named ref / 不正文字を reject する", () => {
    expect(() => validateRev("--exec=evil")).toThrow(/leading '-'/);
    expect(() => validateRev("main")).toThrow(/hex digit/);
    expect(() => validateRev("abc 123")).toThrow(/invalid character/);
  });

  test("isAllZeroHex は UNCOMMITTED_HASH sentinel を検知する", () => {
    expect(isAllZeroHex("0000000000")).toBe(true);
    expect(isAllZeroHex("0000a00000")).toBe(false);
    expect(isAllZeroHex("")).toBe(false);
  });

  test("validateRelPath は option 注入 / 絶対パス / traversal を reject する", () => {
    expect(() => validateRelPath("src/a.ts")).not.toThrow();
    expect(() => validateRelPath("-rf")).toThrow(/leading '-'/);
    expect(() => validateRelPath("/etc/passwd")).toThrow(/absolute path/);
    expect(() => validateRelPath("a/../b")).toThrow(/traversal/);
  });
});

describe("log (integration)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("origin 未設定 repo でも HEAD walk で commit 列と branchHead を返す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-gitlog-test-"));
    tempDirs.push(dir);
    runFixtureGit(["init", "-b", "main"], dir);
    runFixtureGit(["config", "user.email", "t@example.com"], dir);
    runFixtureGit(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    runFixtureGit(["add", "."], dir);
    runFixtureGit(["commit", "-m", "first"], dir);
    writeFileSync(join(dir, "b.txt"), "b\n");
    runFixtureGit(["add", "."], dir);
    runFixtureGit(["commit", "-m", "second"], dir);

    const result = await log({
      dir,
      maxCount: 50,
      firstParentOnly: false,
      branchScope: "default",
      sortMode: "topo",
    });
    expect(result.branchHead).toBe("main");
    expect(result.defaultBranch).toBe("");
    expect(result.commits.map((c) => c.message)).toEqual(["second", "first"]);
    expect(result.commits[0].refs).toContain("HEAD");
    expect(result.commits[1].parents).toEqual([]);
  });

  test('branchScope "all" は HEAD 非到達の別ブランチ commit も walk する', async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-gitlog-all-"));
    tempDirs.push(dir);
    runFixtureGit(["init", "-b", "main"], dir);
    runFixtureGit(["config", "user.email", "t@example.com"], dir);
    runFixtureGit(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    runFixtureGit(["add", "."], dir);
    runFixtureGit(["commit", "-m", "base"], dir);
    // main から分岐した別ブランチに、main へマージされない独立 commit を積む
    runFixtureGit(["checkout", "-b", "feature"], dir);
    writeFileSync(join(dir, "f.txt"), "f\n");
    runFixtureGit(["add", "."], dir);
    runFixtureGit(["commit", "-m", "feature-only"], dir);
    // HEAD を main に戻す。feature-only は HEAD 系統から到達不可になる
    runFixtureGit(["checkout", "main"], dir);

    const common = { dir, maxCount: 50, firstParentOnly: false, sortMode: "topo" as const };
    const defaultScope = await log({ ...common, branchScope: "default" });
    const allScope = await log({ ...common, branchScope: "all" });

    // default (HEAD 起点のみ、origin 未設定) では feature-only は見えない
    expect(defaultScope.commits.map((c) => c.message)).toEqual(["base"]);
    // all では feature ブランチ tip を始点に加えるため feature-only も現れる
    expect(allScope.commits.map((c) => c.message).sort()).toEqual(["base", "feature-only"]);
  });

  test('branchScope "all" で HEAD が maxCount 窓外に押し出されても rescue で末尾 append する', async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-gitlog-all-rescue-"));
    tempDirs.push(dir);
    runFixtureGit(["init", "-b", "main"], dir);
    runFixtureGit(["config", "user.email", "t@example.com"], dir);
    runFixtureGit(["config", "user.name", "t"], dir);
    // main（= HEAD）を古い commit にする
    writeFileSync(join(dir, "a.txt"), "a\n");
    runFixtureGit(["add", "."], dir);
    runFixtureGit(["commit", "-m", "old-head"], dir);
    // main から分岐した feature に、より新しい独立 commit を積む
    runFixtureGit(["checkout", "-b", "feature"], dir);
    writeFileSync(join(dir, "f.txt"), "f\n");
    runFixtureGit(["add", "."], dir);
    runFixtureGit(["commit", "-m", "newer-feature"], dir);
    runFixtureGit(["checkout", "main"], dir);

    // maxCount=1 の all walk は topo 先頭の feature tip だけを返し HEAD(main) を窓外に落とす。
    // rescue が HEAD-only walk を末尾 append し、境界先頭に truncatedAbove を立てる。
    const result = await log({
      dir,
      maxCount: 1,
      firstParentOnly: false,
      branchScope: "all",
      sortMode: "topo",
    });
    expect(result.commits.map((c) => c.message)).toEqual(["newer-feature", "old-head"]);
    // all walk 側 (feature tip) は境界でない
    expect(result.commits[0].truncatedAbove).toBe(false);
    // append された HEAD セグメントの先頭に境界マーカーが立つ
    expect(result.commits[1].refs).toContain("HEAD");
    expect(result.commits[1].truncatedAbove).toBe(true);
  });

  test("unborn branch（commit 無し）は空 commits で正常応答する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-gitlog-unborn-"));
    tempDirs.push(dir);
    runFixtureGit(["init", "-b", "main"], dir);

    const result = await log({
      dir,
      maxCount: 50,
      firstParentOnly: false,
      branchScope: "default",
      sortMode: "topo",
    });
    expect(result.commits).toEqual([]);
    // unborn では symbolic-ref が branch 名を exit 0 で返す
    expect(result.branchHead).toBe("main");
  });
});
