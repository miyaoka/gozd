// createWorktreeSymlinks の境界テスト。git を要さない純 fs ロジックのため、
// main repo / worktree を模した 2 つの temp dir を直接操作して検証する。

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeSymlinks } from "./worktreeOps";

describe("createWorktreeSymlinks", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makePair(): { main: string; wt: string } {
    const main = mkdtempSync(join(tmpdir(), "gozd-symlink-main-"));
    const wt = mkdtempSync(join(tmpdir(), "gozd-symlink-wt-"));
    tempDirs.push(main, wt);
    return { main, wt };
  }

  test("source があり dest 未存在なら symlink を張る", () => {
    const { main, wt } = makePair();
    writeFileSync(join(main, ".env.local"), "X=1\n");
    createWorktreeSymlinks(main, wt, [".env.local"]);
    const dest = join(wt, ".env.local");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(join(main, ".env.local"));
  });

  test("source 不在の target は skip する", () => {
    const { main, wt } = makePair();
    createWorktreeSymlinks(main, wt, [".missing"]);
    expect(existsSync(join(wt, ".missing"))).toBe(false);
  });

  test("dest 既存の target は skip し上書きしない", () => {
    const { main, wt } = makePair();
    writeFileSync(join(main, ".claude"), "main");
    writeFileSync(join(wt, ".claude"), "existing");
    createWorktreeSymlinks(main, wt, [".claude"]);
    const dest = join(wt, ".claude");
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe("existing");
  });

  test("nested target は dest 親ディレクトリを作って symlink する", () => {
    const { main, wt } = makePair();
    mkdirSync(join(main, ".config"));
    writeFileSync(join(main, ".config", "app.json"), "{}");
    createWorktreeSymlinks(main, wt, [".config/app.json"]);
    const dest = join(wt, ".config", "app.json");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(join(main, ".config", "app.json"));
  });

  test("`..` traversal target は rejected で skip する", () => {
    const { main, wt } = makePair();
    createWorktreeSymlinks(main, wt, ["../escape"]);
    expect(existsSync(join(wt, "escape"))).toBe(false);
  });

  test("中間パスが非ディレクトリでも throw せず後続 target を処理する", () => {
    const { main, wt } = makePair();
    // source .config/foo は存在させる（source 存在 check を通過させて mkdir 経路に入れる）
    mkdirSync(join(main, ".config"));
    writeFileSync(join(main, ".config", "foo"), "src");
    writeFileSync(join(main, ".env"), "E=1");
    // worktree 側の .config はファイル。mkdir(wt/.config) が throw する端ケースを作る
    writeFileSync(join(wt, ".config"), "blocker");
    expect(() => createWorktreeSymlinks(main, wt, [".config/foo", ".env"])).not.toThrow();
    // 前段が throw しても後続 .env は張られる（worktree 作成全体を止めない不変条件）
    expect(lstatSync(join(wt, ".env")).isSymbolicLink()).toBe(true);
  });
});
