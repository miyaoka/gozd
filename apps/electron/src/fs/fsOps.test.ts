// fsOps の統合テスト。Swift 版 `FSOpsTests.swift` のケースを対で移植し、
// notFound 規律 / path traversal 拒否 / `.git` 完全一致除外の契約を固定する。

import { tryCatch } from "@gozd/shared";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDir, readFile } from "./fsOps";

describe("FSOps", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-fsops-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      // permission テストで読み取り不能にした dir も削除できるよう戻す
      // （テスト内で削除済みの dir は chmod が ENOENT になるため握る）
      tryCatch(() => chmodSync(dir, 0o755));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dir 配下の text ファイルを読める", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "hello.txt"), "hello gozd\n");
    const info = readFile(dir, "hello.txt");
    expect(info.content).toBe("hello gozd\n");
    expect(info.notFound).toBe(false);
  });

  test("バイナリファイルは生 bytes がそのまま返される", () => {
    const dir = makeTempDir();
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    writeFileSync(join(dir, "bin.dat"), bytes);
    const info = readFile(dir, "bin.dat");
    expect(info.content).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(info.content as Uint8Array).equals(bytes)).toBe(true);
  });

  test("dir 範囲外への path traversal は outsideDir で拒否される", () => {
    const dir = makeTempDir();
    expect(() => readFile(dir, "../escape.txt")).toThrow(/outsideDir/);
  });

  test("ファイル / ディレクトリ / symlink を type 付きで返す", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "file.txt"), "x");
    mkdirSync(join(dir, "subdir"));
    symlinkSync(join(dir, "file.txt"), join(dir, "link"));
    const result = await readDir(dir, "");
    expect(result.notFound).toBe(false);
    expect(result.entries).toEqual([
      { name: "file.txt", type: "file", isIgnored: false },
      { name: "link", type: "symlink", isIgnored: false },
      { name: "subdir", type: "directory", isIgnored: false },
    ]);
  });

  test("空ディレクトリは空配列", async () => {
    const dir = makeTempDir();
    const result = await readDir(dir, "");
    expect(result.entries).toEqual([]);
    expect(result.notFound).toBe(false);
  });

  test("存在しないディレクトリは throw せず notFound を返す", async () => {
    const dir = makeTempDir();
    const result = await readDir(dir, "gone");
    expect(result.notFound).toBe(true);
    expect(result.entries).toEqual([]);
  });

  test('dir (worktree root) 自体が削除済みでも path="." は outsideDir でなく notFound', async () => {
    const dir = makeTempDir();
    rmSync(dir, { recursive: true });
    const result = await readDir(dir, ".");
    expect(result.notFound).toBe(true);
  });

  test("ディレクトリが同名ファイルに置換された場合も notFound を返す", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "node"));
    rmSync(join(dir, "node"), { recursive: true });
    writeFileSync(join(dir, "node"), "not a dir");
    const result = await readDir(dir, "node");
    expect(result.notFound).toBe(true);
  });

  test("読み取り権限の無いディレクトリは notFound ではなく throw する", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "locked"));
    chmodSync(join(dir, "locked"), 0o000);
    expect(readDir(dir, "locked")).rejects.toThrow();
    chmodSync(join(dir, "locked"), 0o755);
  });

  test("dir 範囲外は拒否される", async () => {
    const dir = makeTempDir();
    expect(readDir(dir, "../..")).rejects.toThrow(/outsideDir/);
  });

  test(".git directory は除外、近傍名 (.gitignore, .gita 等) は残る (完全一致境界)", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "");
    writeFileSync(join(dir, ".gita"), "");
    const result = await readDir(dir, "");
    expect(result.entries.map((entry) => entry.name)).toEqual([".gita", ".gitignore"]);
  });

  test(".git file (worktree gitlink) は除外、近傍名は残る (完全一致境界)", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".git"), "gitdir: /somewhere/.git/worktrees/x");
    writeFileSync(join(dir, ".gitmodules"), "");
    const result = await readDir(dir, "");
    expect(result.entries.map((entry) => entry.name)).toEqual([".gitmodules"]);
  });

  test("git repo 内では .gitignore に一致する entry の isIgnored=true", async () => {
    const dir = makeTempDir();
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, ".gitignore"), "dist/\n*.log\n");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "app.log"), "");
    writeFileSync(join(dir, "keep.ts"), "");
    const result = await readDir(dir, "");
    const byName = new Map(result.entries.map((entry) => [entry.name, entry.isIgnored]));
    expect(byName.get("dist")).toBe(true);
    expect(byName.get("app.log")).toBe(true);
    expect(byName.get("keep.ts")).toBe(false);
    expect(byName.get(".gitignore")).toBe(false);
  });
});
