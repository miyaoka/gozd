// fsOps の統合テスト。Swift 版 `FSOpsTests.swift` のケースを対で移植し、
// notFound 規律 / path traversal 拒否 / `.git` 完全一致除外の契約を固定する。

import { tryCatch } from "@gozd/shared";
import { afterEach, describe, expect, test } from "bun:test";
import { runFixtureGit } from "../testGitFixture";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDir, readFile, writeFileAbsolute } from "./fsOps";

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
      {
        name: "link",
        type: "symlink",
        realTarget: {
          type: "file",
          absPath: join(realpathSync(dir), "file.txt"),
          relPath: "file.txt",
        },
        isIgnored: false,
      },
      { name: "subdir", type: "directory", isIgnored: false },
    ]);
  });

  test("ディレクトリへの symlink は realTarget.type: 'directory' を併記する", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "subdir"));
    symlinkSync(join(dir, "subdir"), join(dir, "dirlink"));
    const result = await readDir(dir, "");
    expect(result.entries[0]?.realTarget).toEqual({
      type: "directory",
      absPath: join(realpathSync(dir), "subdir"),
      relPath: "subdir",
    });
  });

  test("dir 外を指す symlink は realTarget.relPath 不在で返る", async () => {
    const dir = makeTempDir();
    const outside = makeTempDir();
    writeFileSync(join(outside, "outer.txt"), "x");
    symlinkSync(join(outside, "outer.txt"), join(dir, "outlink"));
    const result = await readDir(dir, "");
    expect(result.entries[0]?.realTarget).toEqual({
      type: "file",
      absPath: join(realpathSync(outside), "outer.txt"),
      relPath: undefined,
    });
  });

  test("辿れない symlink は realTarget 不在で返る", async () => {
    const dir = makeTempDir();
    symlinkSync(join(dir, "missing.txt"), join(dir, "dangling"));
    symlinkSync(join(dir, "loop"), join(dir, "loop"));
    const result = await readDir(dir, "");
    expect(result.entries).toEqual([
      { name: "dangling", type: "symlink", realTarget: undefined, isIgnored: false },
      { name: "loop", type: "symlink", realTarget: undefined, isIgnored: false },
    ]);
  });

  test("symlink 配下はリンク越しに列挙でき、entry 自身が link でなくても realTarget を持つ", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "subdir", "nested"), { recursive: true });
    writeFileSync(join(dir, "subdir", "inner.txt"), "x");
    symlinkSync(join(dir, "subdir"), join(dir, "dirlink"));
    const result = await readDir(dir, "dirlink");
    expect(result.notFound).toBe(false);
    expect(result.entries).toEqual([
      {
        name: "inner.txt",
        type: "file",
        realTarget: {
          type: "file",
          absPath: join(realpathSync(dir), "subdir", "inner.txt"),
          relPath: join("subdir", "inner.txt"),
        },
        isIgnored: false,
      },
      {
        name: "nested",
        type: "directory",
        realTarget: {
          type: "directory",
          absPath: join(realpathSync(dir), "subdir", "nested"),
          relPath: join("subdir", "nested"),
        },
        isIgnored: false,
      },
    ]);
  });

  test("link を経由しない列挙は realTarget を持たない（実体とツリー上のパスが一致）", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "subdir"));
    writeFileSync(join(dir, "subdir", "inner.txt"), "x");
    const result = await readDir(dir, "subdir");
    expect(result.entries).toEqual([{ name: "inner.txt", type: "file", isIgnored: false }]);
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
    runFixtureGit(["init"], dir);
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

  test("symlink 越しの列挙でも実体側の path で gitignore 判定する", async () => {
    const dir = makeTempDir();
    runFixtureGit(["init"], dir);
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "app.log"), "");
    writeFileSync(join(dir, "real", "keep.ts"), "");
    symlinkSync(join(dir, "real"), join(dir, "link"));
    // link 越しの pathspec を渡すと git が fatal になり全 entry の判定が落ちる。実体側の
    // 相対パスで問い合わせることで、link 経由で見ても ignored が付く
    const result = await readDir(dir, "link");
    const byName = new Map(result.entries.map((entry) => [entry.name, entry.isIgnored]));
    expect(byName.get("app.log")).toBe(true);
    expect(byName.get("keep.ts")).toBe(false);
  });

  test("dir 外を指す entry が混ざっても、同じ列挙内の ignored 判定は壊れない", async () => {
    // dir 外の pathspec を batch に混ぜると git が fatal して batch 全体が落ちる。dir 外は
    // 問い合わせから外す決定が効いていれば、同居する worktree 内 entry の判定だけが残る
    const dir = makeTempDir();
    const outside = makeTempDir();
    runFixtureGit(["init"], dir);
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "app.log"), "");
    writeFileSync(join(outside, "outer.txt"), "");
    symlinkSync(join(outside, "outer.txt"), join(dir, "real", "outlink"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const result = await readDir(dir, "link");
    const byName = new Map(result.entries.map((entry) => [entry.name, entry.isIgnored]));
    expect(byName.get("app.log")).toBe(true);
    expect(byName.get("outlink")).toBe(false);
    expect(result.entries.find((entry) => entry.name === "outlink")?.realTarget).toEqual({
      type: "file",
      absPath: join(realpathSync(outside), "outer.txt"),
      relPath: undefined,
    });
  });

  test("link 越し列挙の symlink 行は、リンク先ではなく行自身の path で ignored 判定する", async () => {
    const dir = makeTempDir();
    runFixtureGit(["init"], dir);
    // リンク先 (logs/) は ignored、リンク自身 (real/data) は ignored ではない
    writeFileSync(join(dir, ".gitignore"), "/logs\n");
    mkdirSync(join(dir, "logs"));
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "logs"), join(dir, "real", "data"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const result = await readDir(dir, "link");
    expect(result.entries[0]?.name).toBe("data");
    expect(result.entries[0]?.isIgnored).toBe(false);
  });

  test("末尾スラッシュ付き path でも link 越し判定が誤爆しない", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "subdir"));
    writeFileSync(join(dir, "subdir", "inner.txt"), "x");
    const result = await readDir(dir, "subdir/");
    expect(result.entries).toEqual([{ name: "inner.txt", type: "file", isIgnored: false }]);
  });

  test("writeFileAbsolute は絶対パスに書き込め、tmp ファイルを残さない", () => {
    const dir = makeTempDir();
    const path = join(dir, "config.json");
    writeFileAbsolute(path, '{"a":1}');
    expect(readFileSync(path, "utf8")).toBe('{"a":1}');
    // atomic write (tmp + rename) の tmp が残骸として残らない
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  test("writeFileAbsolute は既存ファイルを上書きできる", () => {
    const dir = makeTempDir();
    const path = join(dir, "config.json");
    writeFileAbsolute(path, "old");
    writeFileAbsolute(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  test("writeFileAbsolute は非絶対パスを reject する", () => {
    const result = tryCatch(() => writeFileAbsolute("relative/config.json", "x"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain("notAbsolutePath");
  });

  test("writeFileAbsolute は親 dir 不在なら失敗する (作成しない)", () => {
    const dir = makeTempDir();
    const result = tryCatch(() => writeFileAbsolute(join(dir, "missing", "a.txt"), "x"));
    expect(result.ok).toBe(false);
  });
});
