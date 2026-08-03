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

  test("循環 symlink のディレクトリはエラーではなく notFound を返す", async () => {
    // 辿れない link は削除ノードと同じ扱い。ここで throw に倒すと、壊れた link 1 本で
    // 親の fsChange のたびにエラートーストが出続ける
    const dir = makeTempDir();
    symlinkSync(join(dir, "loop"), join(dir, "loop"));
    const result = await readDir(dir, "loop");
    expect(result.notFound).toBe(true);
  });

  test("親ディレクトリの権限で recheck が失敗する場合も notFound ではなく throw する", async () => {
    // recheck 自身の失敗を notFound に倒すと、権限の問題が「削除された」として UI に出る
    const dir = makeTempDir();
    mkdirSync(join(dir, "locked", "sub"), { recursive: true });
    chmodSync(join(dir, "locked"), 0o000);
    // 他の rejects と違い Result で受けるのは、assert 前に権限を戻す必要があるため。子を持つこの
    // dir を 000 のまま残すと afterEach の rmSync ごと落ちる
    const failed = await tryCatch(readDir(dir, "locked/sub"));
    chmodSync(join(dir, "locked"), 0o755);
    expect(failed.ok).toBe(false);
    expect(String(failed.ok ? "" : failed.error)).toMatch(/EACCES/);
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

  // submodule の working tree はディスク上ただのディレクトリなので、判定は index の gitlink
  // （mode 160000）だけが根拠になる。`update-index --cacheinfo` は commit object の実在を
  // 要求しないため、未初期化 submodule と同じ状態をネットワーク無しで作れる
  const GITLINK_HASH = "1111111111111111111111111111111111111111";

  function addGitlink(dir: string, relPath: string): void {
    runFixtureGit(
      ["update-index", "--add", "--cacheinfo", `160000,${GITLINK_HASH},${relPath}`],
      dir,
    );
  }

  test("index の gitlink はディレクトリではなく submodule として返る", async () => {
    const dir = makeTempDir();
    runFixtureGit(["init"], dir);
    mkdirSync(join(dir, "lib"));
    mkdirSync(join(dir, "src"));
    addGitlink(dir, "lib");
    const result = await readDir(dir, "");
    const byName = new Map(result.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("lib")?.type).toBe("submodule");
    expect(byName.get("lib")?.submoduleHash).toBe(GITLINK_HASH);
    // gitlink でないディレクトリは巻き込まれない
    expect(byName.get("src")?.type).toBe("directory");
    expect(byName.get("src")?.submoduleHash).toBeUndefined();
  });

  test("孫の gitlink は列挙階層の同名 entry を submodule にしない", async () => {
    const dir = makeTempDir();
    runFixtureGit(["init"], dir);
    mkdirSync(join(dir, "vendor", "lib"), { recursive: true });
    // 孫 gitlink と basename が衝突するディレクトリを列挙階層に置く。1 階層に閉じていないと
    // `vendor/lib` の gitlink がこの `lib` に載る
    mkdirSync(join(dir, "lib"));
    addGitlink(dir, "vendor/lib");
    const root = await readDir(dir, "");
    const byName = new Map(root.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("lib")?.type).toBe("directory");
    expect(byName.get("vendor")?.type).toBe("directory");
    const nested = await readDir(dir, "vendor");
    expect(nested.entries.find((entry) => entry.name === "lib")?.type).toBe("submodule");
  });

  test("ディレクトリ名が glob メタ文字を含んでも判定がずれない", async () => {
    // `[slug]` のような動的ルートは Next.js / Nuxt で実在する。ディレクトリ名を pathspec の
    // パターンとして渡すと文字クラスに解釈され、`app/s/*` にも一致して兄弟の gitlink を拾い、
    // 本物の gitlink を取り逃す
    const dir = makeTempDir();
    runFixtureGit(["init"], dir);
    mkdirSync(join(dir, "app", "[slug]", "plain"), { recursive: true });
    mkdirSync(join(dir, "app", "[slug]", "mod"), { recursive: true });
    mkdirSync(join(dir, "app", "s", "plain"), { recursive: true });
    addGitlink(dir, "app/[slug]/mod");
    addGitlink(dir, "app/s/plain");
    const result = await readDir(dir, "app/[slug]");
    const byName = new Map(result.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("mod")?.type).toBe("submodule");
    expect(byName.get("plain")?.type).toBe("directory");
    expect(byName.get("plain")?.submoduleHash).toBeUndefined();
  });

  test("gitlink の path がディスク上 file なら実体の種別を優先する", async () => {
    const dir = makeTempDir();
    runFixtureGit(["init"], dir);
    writeFileSync(join(dir, "lib"), "");
    // gitlink 問い合わせはディレクトリを含む階層でしか走らないため、無関係な dir を 1 つ置く
    mkdirSync(join(dir, "src"));
    addGitlink(dir, "lib");
    const result = await readDir(dir, "");
    expect(result.entries.find((entry) => entry.name === "lib")?.type).toBe("file");
  });

  test("conflict 中の gitlink は working tree と同じ ours (stage 2) を返す", async () => {
    // base / ours / theirs の 3 者が揃う形にして stage 1/2/3 をすべて出す。base を落とすと
    // 「stage を見ずに先勝ち / 後勝ちで拾う」実装との差が出ない
    const base = "1".repeat(40);
    const ours = "2".repeat(40);
    const theirs = "3".repeat(40);
    const dir = makeTempDir();
    runFixtureGit(["init", "-b", "main"], dir);
    // commit する fixture は identity を repo-local に固定する。未設定でも git は OS の
    // gecos / ホスト名から自動導出するが、それが空になる環境では `empty ident name` で落ちる
    runFixtureGit(["config", "user.email", "t@example.com"], dir);
    runFixtureGit(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "seed.txt"), "x");
    runFixtureGit(["add", "seed.txt"], dir);
    runFixtureGit(["commit", "-m", "seed"], dir);
    runFixtureGit(["update-index", "--add", "--cacheinfo", `160000,${base},conf`], dir);
    runFixtureGit(["commit", "-m", "base"], dir);
    runFixtureGit(["checkout", "-b", "other"], dir);
    runFixtureGit(["update-index", "--add", "--cacheinfo", `160000,${theirs},conf`], dir);
    runFixtureGit(["commit", "-m", "theirs"], dir);
    runFixtureGit(["checkout", "main"], dir);
    runFixtureGit(["update-index", "--add", "--cacheinfo", `160000,${ours},conf`], dir);
    runFixtureGit(["commit", "-m", "ours"], dir);
    // conflict する merge は非 0 終了する。conflict 状態を作るのが目的なので失敗は握る
    tryCatch(() => runFixtureGit(["merge", "other"], dir));
    mkdirSync(join(dir, "conf"), { recursive: true });
    const result = await readDir(dir, "");
    const conf = result.entries.find((entry) => entry.name === "conf");
    expect(conf?.type).toBe("submodule");
    expect(conf?.submoduleHash).toBe(ours);
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

  test("dir 外を指す link が同居しても、他の行の ignored 判定と realTarget は保たれる", async () => {
    // 判定対象は行自身なので、行の実体が dir 外でも pathspec は worktree 内（列挙対象 + 行名）に
    // なる。pathspec の worktree 内 / 外は列挙単位で揃うため、外を指す行の同居で batch が落ちない
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
