// gitTree の pure parser test + 実 git repo での統合テスト。

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitFiles,
  fileReadResultFromGit,
  lsTree,
  parseDiffNameStatus,
  parseLsTree,
  typeFromGitMode,
} from "./gitTree";

describe("parseDiffNameStatus", () => {
  test("通常エントリと rename エントリを分解する", () => {
    const text = "M\0src/a.ts\0R100\0old.ts\0new.ts\0A\0added.ts\0";
    expect(parseDiffNameStatus(text)).toEqual([
      { oldPath: "src/a.ts", newPath: "src/a.ts", type: "M" },
      { oldPath: "old.ts", newPath: "new.ts", type: "R" },
      { oldPath: "added.ts", newPath: "added.ts", type: "A" },
    ]);
  });

  test("空出力は空配列", () => {
    expect(parseDiffNameStatus("")).toEqual([]);
  });
});

describe("parseLsTree / typeFromGitMode", () => {
  test("mode → type 写像", () => {
    expect(typeFromGitMode("040000")).toBe("directory");
    expect(typeFromGitMode("120000")).toBe("symlink");
    expect(typeFromGitMode("160000")).toBe("submodule");
    expect(typeFromGitMode("100644")).toBe("file");
  });

  test("ls-tree -z レコードを name 昇順で返す（parent path は basename 化）", () => {
    // `\0` 直後に数字が続くと octal escape に解釈されるため join で NUL 区切りを組む
    const text = ["100644 blob abc\tsrc/zeta.ts", "040000 tree def\tsrc/alpha", ""].join("\0");
    expect(parseLsTree(text)).toEqual([
      { name: "alpha", type: "directory" },
      { name: "zeta.ts", type: "file" },
    ]);
  });

  test("TAB 欠落レコードは silent skip せず throw する", () => {
    expect(() => parseLsTree("100644 blob abc src/a.ts\0")).toThrow(/TAB separator/);
  });
});

describe("gitTree (integration)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-gittree-test-"));
    tempDirs.push(dir);
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
    return dir;
  }

  function commit(dir: string, message: string): string {
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "ignore" });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  }

  test("fileReadResultFromGit: HEAD の blob を読み、未追跡 path は notFound", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "hello\n");
    commit(dir, "first");
    const found = await fileReadResultFromGit(dir, "HEAD", "a.txt");
    expect(found).toEqual({ content: "hello\n", isBinary: false, isDirectory: false, notFound: false });
    const missing = await fileReadResultFromGit(dir, "HEAD", "nope.txt");
    expect(missing.notFound).toBe(true);
  });

  test("fileReadResultFromGit: NUL byte 入り blob は isBinary=true", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0x00, 0x01, 0xff]));
    commit(dir, "bin");
    const result = await fileReadResultFromGit(dir, "HEAD", "bin.dat");
    expect(result.isBinary).toBe(true);
    expect(result.content).toBe("");
  });

  test("lsTree: 1 階層分のエントリを type 付きで返す", async () => {
    const dir = makeRepo();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "a");
    writeFileSync(join(dir, "root.txt"), "r");
    const hash = commit(dir, "tree");
    expect(await lsTree(dir, hash, "")).toEqual([
      { name: "root.txt", type: "file" },
      { name: "src", type: "directory" },
    ]);
    expect(await lsTree(dir, hash, "src")).toEqual([{ name: "a.ts", type: "file" }]);
  });

  test("lsTree: UNCOMMITTED_HASH / 空 hash は入口で reject する", async () => {
    const dir = makeRepo();
    expect(lsTree(dir, "", "")).rejects.toThrow(/must be specified/);
    expect(lsTree(dir, "0000000000000000000000000000000000000000", "")).rejects.toThrow(
      /UNCOMMITTED_HASH/,
    );
  });

  test("commitFiles: root commit は diff-tree --root で追加ファイルを返す", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    const root = commit(dir, "root");
    const changes = await commitFiles({
      dir,
      hash: root,
      rangeHashes: [],
      includeWorkingTree: false,
    });
    expect(changes).toEqual([{ oldPath: "a.txt", newPath: "a.txt", type: "A" }]);
  });

  test("commitFiles: 非 root commit は <hash>^ vs <hash> の差分を返す", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    commit(dir, "first");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, "b.txt"), "b\n");
    const second = commit(dir, "second");
    const changes = await commitFiles({
      dir,
      hash: second,
      rangeHashes: [],
      includeWorkingTree: false,
    });
    expect(changes).toEqual([
      { oldPath: "a.txt", newPath: "a.txt", type: "M" },
      { oldPath: "b.txt", newPath: "b.txt", type: "A" },
    ]);
  });

  test("commitFiles: range 指定は older^ vs newer の 2 endpoint diff（older が root なら empty tree 起点）", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    const root = commit(dir, "root");
    writeFileSync(join(dir, "b.txt"), "b\n");
    const second = commit(dir, "second");
    const changes = await commitFiles({
      dir,
      hash: "",
      rangeHashes: [second, root],
      includeWorkingTree: false,
    });
    // root の追加分（a.txt）も empty tree 起点で含まれる
    expect(changes).toEqual([
      { oldPath: "a.txt", newPath: "a.txt", type: "A" },
      { oldPath: "b.txt", newPath: "b.txt", type: "A" },
    ]);
  });
});
