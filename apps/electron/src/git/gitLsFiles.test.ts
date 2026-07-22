// subtractDeleted の pure test + 実 git repo での lsFiles 統合テスト。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureGit } from "../testGitFixture";
import { lsFiles, subtractDeleted } from "./gitLsFiles";

describe("subtractDeleted", () => {
  test("NUL 区切り出力をパス配列に分解する", () => {
    expect(subtractDeleted("a.ts\0src/b.ts\0", "")).toEqual(["a.ts", "src/b.ts"]);
  });

  test("deleted に含まれるパスを除外する", () => {
    expect(subtractDeleted("a.ts\0b.ts\0c.ts\0", "b.ts\0")).toEqual(["a.ts", "c.ts"]);
  });

  test("空出力は空配列", () => {
    expect(subtractDeleted("", "")).toEqual([]);
  });
});

describe("lsFiles (integration)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("tracked + untracked を列挙し、gitignore と working tree 削除済みを除外する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-lsfiles-test-"));
    tempDirs.push(dir);
    runFixtureGit(["init", "-b", "main"], dir);
    runFixtureGit(["config", "user.email", "t@example.com"], dir);
    runFixtureGit(["config", "user.name", "t"], dir);

    // tracked
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "tracked.ts"), "a\n");
    writeFileSync(join(dir, "removed.ts"), "b\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
    runFixtureGit(["add", "."], dir);
    runFixtureGit(["commit", "-m", "first"], dir);

    // untracked / ignored / working tree 削除
    writeFileSync(join(dir, "untracked.ts"), "c\n");
    writeFileSync(join(dir, "ignored.log"), "d\n");
    unlinkSync(join(dir, "removed.ts"));

    const files = await lsFiles(dir);
    expect(files).toContain("src/tracked.ts");
    expect(files).toContain("untracked.ts");
    expect(files).toContain(".gitignore");
    expect(files).not.toContain("ignored.log");
    expect(files).not.toContain("removed.ts");
  });

  test("merge コンフリクト中も unmerged パスを 1 件に畳む", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-lsfiles-conflict-"));
    tempDirs.push(dir);
    runFixtureGit(["init", "-b", "main"], dir);
    runFixtureGit(["config", "user.email", "t@example.com"], dir);
    runFixtureGit(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "conflict.txt"), "base\n");
    runFixtureGit(["add", "."], dir);
    runFixtureGit(["commit", "-m", "base"], dir);
    runFixtureGit(["checkout", "-b", "topic"], dir);
    writeFileSync(join(dir, "conflict.txt"), "topic\n");
    runFixtureGit(["commit", "-am", "topic"], dir);
    runFixtureGit(["checkout", "main"], dir);
    writeFileSync(join(dir, "conflict.txt"), "main\n");
    runFixtureGit(["commit", "-am", "main"], dir);
    // コンフリクトで merge は exit 1 になる（期待挙動なので失敗を握りつぶす）
    expect(() => runFixtureGit(["merge", "topic"], dir)).toThrow();

    const files = await lsFiles(dir);
    expect(files.filter((path) => path === "conflict.txt").length).toBe(1);
  });

  test("commit 無し repo でも untracked を列挙する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-lsfiles-unborn-"));
    tempDirs.push(dir);
    runFixtureGit(["init", "-b", "main"], dir);
    writeFileSync(join(dir, "a.ts"), "a\n");

    expect(await lsFiles(dir)).toEqual(["a.ts"]);
  });
});
