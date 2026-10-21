// gitLog の parser pure test + 実 git repo での統合テスト。
// parseRefs / parseLogRecords の契約は Swift 版 GitOps+Log.swift の parser と対。

import { afterEach, describe, expect, test } from "bun:test";
import { runFixtureGit } from "../testGitFixture";
import { execFileSync } from "node:child_process";
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
  const HASH_A = "a".repeat(40);
  const HASH_B = "b".repeat(40);
  const AUTHOR = "author alice <alice@example.com> 1700000000 +0900";

  /** raw 出力の 1 record。メッセージ行は git と同じく 4 文字インデントし、末尾に区切りの空行を付ける */
  const record = (commitLine: string, header: string[], message: string[]) =>
    `${[commitLine, ...header, "", ...message.map((line) => `    ${line}`), ""].join("\n")}\n`;

  test("raw record を CommitInfo に変換する", () => {
    const text = record(
      `commit ${HASH_A} (HEAD -> main, origin/main)`,
      ["tree t", `parent ${HASH_B}`, "parent c1", AUTHOR, "committer c <c@example.com> 1 +0000"],
      ["subject", "", "body 1", "", "body 2"],
    );
    expect(parseLogRecords(text)).toEqual([
      {
        hash: HASH_A,
        shortHash: "aaaaaaa",
        parents: [HASH_B, "c1"],
        author: "alice",
        date: 1700000000,
        message: "subject",
        body: "body 1\n\nbody 2",
        refs: ["HEAD", "main", "origin/main"],
        truncatedAbove: false,
        signature: "none",
      },
    ]);
  });

  test("複数 record を順に返し、ref の無い commit 行と root commit を扱う", () => {
    const text =
      record(`commit ${HASH_A}`, ["tree t", `parent ${HASH_B}`, AUTHOR], ["first"]) +
      record(`commit ${HASH_B}`, ["tree t", AUTHOR], ["root"]);
    const commits = parseLogRecords(text);
    expect(commits.map((c) => [c.hash, c.parents, c.refs, c.message])).toEqual([
      [HASH_A, [HASH_B], [], "first"],
      [HASH_B, [], [], "root"],
    ]);
  });

  test("subject は最初の段落を空白で連結し、body が無ければ空文字", () => {
    const text = record(`commit ${HASH_A}`, ["tree t", AUTHOR], ["line 1", "line 2"]);
    expect(parseLogRecords(text)[0]).toMatchObject({ message: "line 1 line 2", body: "" });
  });

  test("メッセージ中の commit / gpgsig で始まる行は record の先頭や署名とみなさない", () => {
    const text = record(
      `commit ${HASH_A}`,
      ["tree t", AUTHOR],
      ["subject", "", `commit ${HASH_B}`, "gpgsig -----BEGIN SSH SIGNATURE-----"],
    );
    const commits = parseLogRecords(text);
    expect(commits).toHaveLength(1);
    expect(commits[0].signature).toBe("none");
  });

  test("署名ヘッダの armor から方式を判別する", () => {
    const signed = (key: string, armor: string) =>
      parseLogRecords(
        record(`commit ${HASH_A}`, ["tree t", AUTHOR, `${key} ${armor}`, " xxx"], ["s"]),
      )[0].signature;
    expect(signed("gpgsig", "-----BEGIN SSH SIGNATURE-----")).toBe("ssh");
    expect(signed("gpgsig", "-----BEGIN PGP SIGNATURE-----")).toBe("gpg");
    expect(signed("gpgsig-sha256", "-----BEGIN SIGNED MESSAGE-----")).toBe("x509");
    expect(signed("gpgsig", "-----BEGIN FUTURE-----")).toBe("unknown");
  });

  test("想定外の形は silent skip せず throw する", () => {
    expect(() => parseLogRecords("tree t\n")).toThrow(/before the first commit/);
    expect(() => parseLogRecords(record("commit xyz", ["tree t", AUTHOR], ["s"]))).toThrow(
      /malformed commit line/,
    );
    expect(() => parseLogRecords(record(`commit ${HASH_A}`, ["tree t"], ["s"]))).toThrow(
      /no author header/,
    );
    expect(() =>
      parseLogRecords(
        record(
          `commit ${HASH_A}`,
          ["tree t", "author alice <a@example.com> not-a-date +0000"],
          ["s"],
        ),
      ),
    ).toThrow(/malformed author header/);
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

  test("SSH 署名した commit は ssh、署名していない commit は none になる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-gitlog-signed-"));
    tempDirs.push(dir);
    const keyPath = join(dir, "signing-key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath], {
      stdio: "ignore",
    });
    runFixtureGit(["init", "-b", "main"], dir);
    runFixtureGit(["config", "user.email", "t@example.com"], dir);
    runFixtureGit(["config", "user.name", "t"], dir);
    runFixtureGit(["config", "gpg.format", "ssh"], dir);
    runFixtureGit(["config", "user.signingkey", keyPath], dir);
    runFixtureGit(["commit", "--allow-empty", "-m", "unsigned"], dir);
    runFixtureGit(["commit", "--allow-empty", "-S", "-m", "signed"], dir);

    const result = await log({
      dir,
      maxCount: 50,
      firstParentOnly: false,
      branchScope: "default",
      sortMode: "topo",
    });
    expect(result.commits.map((c) => [c.message, c.signature])).toEqual([
      ["signed", "ssh"],
      ["unsigned", "none"],
    ]);
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
