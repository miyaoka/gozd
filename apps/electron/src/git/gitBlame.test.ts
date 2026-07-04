// gitBlame の統合テスト。実 git repo で blame porcelain parse と blame-anchored log の契約を固定する。

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blameLine, logFile, logLine } from "./gitBlame";

describe("gitBlame (integration)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-blame-test-"));
    tempDirs.push(dir);
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "alice@example.com"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "alice"], { cwd: dir, stdio: "ignore" });
    return dir;
  }

  function commit(dir: string, message: string): string {
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "ignore" });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  }

  test("blameLine: コミット済み行の author / summary / hash を返す", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
    const hash = commit(dir, "first commit");
    const info = await blameLine({ dir, relPath: "a.txt", rev: "", line: 2 });
    expect(info.hash).toBe(hash);
    expect(info.shortHash).toBe(hash.slice(0, 7));
    expect(info.author).toBe("alice");
    expect(info.authorMail).toBe("alice@example.com");
    expect(info.summary).toBe("first commit");
    expect(info.sourceLine).toBe(2);
    expect(info.notCommitted).toBe(false);
    expect(info.authorTime).toBeGreaterThan(0);
  });

  test("blameLine: working tree の未コミット行は notCommitted=true", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "line1\n");
    commit(dir, "first");
    writeFileSync(join(dir, "a.txt"), "line1\nuncommitted\n");
    const info = await blameLine({ dir, relPath: "a.txt", rev: "", line: 2 });
    expect(info.notCommitted).toBe(true);
  });

  test("logLine: 指定行の変更履歴を blame した commit 起点で返す", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "v1\n");
    commit(dir, "first");
    writeFileSync(join(dir, "a.txt"), "v2\n");
    const second = commit(dir, "second");
    const commits = await logLine({ dir, relPath: "a.txt", rev: second, line: 1, maxCount: 10 });
    expect(commits.map((c) => c.message)).toEqual(["second", "first"]);
  });

  test("logLine: 空 rev は blame-anchored 契約違反として reject する", async () => {
    const dir = makeRepo();
    expect(logLine({ dir, relPath: "a.txt", rev: "", line: 1, maxCount: 10 })).rejects.toThrow(
      /rev must be specified/,
    );
  });

  test("logLine: path に ':' を含むと -L syntax が壊れるため reject する", async () => {
    const dir = makeRepo();
    expect(
      logLine({ dir, relPath: "a:b.txt", rev: "abc123", line: 1, maxCount: 10 }),
    ).rejects.toThrow(/contains ':'/);
  });

  test("logFile: rev 空は HEAD walk でファイル履歴を返す", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commit(dir, "touch a");
    writeFileSync(join(dir, "b.txt"), "b\n");
    commit(dir, "touch b");
    const commits = await logFile({ dir, relPath: "a.txt", rev: "", maxCount: 10 });
    expect(commits.map((c) => c.message)).toEqual(["touch a"]);
  });
});
