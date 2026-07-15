// createWorktreeSymlinks の境界テスト。git を要さない純 fs ロジックのため、
// main repo / worktree を模した 2 つの temp dir を直接操作して検証する。

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
import { createWorktreeSymlinks, resolveReviveBranch } from "./worktreeOps";

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

  test("`..` traversal target は rejected で skip する（containment を外すと張られる位置を検証）", () => {
    // main と wt を別々の親 dir 配下に置き、`..` の脱出先を各親に用意する。
    // containment が無効なら source=mainParent/escape を dest=wtParent/escape に張るため、
    // 脱出先の非生成を assert すれば「rejected による skip」を実証できる（source 不在 skip と区別）。
    const mainParent = mkdtempSync(join(tmpdir(), "gozd-symlink-mainp-"));
    const wtParent = mkdtempSync(join(tmpdir(), "gozd-symlink-wtp-"));
    tempDirs.push(mainParent, wtParent);
    const main = join(mainParent, "repo");
    const wt = join(wtParent, "repo");
    mkdirSync(main);
    mkdirSync(wt);
    writeFileSync(join(mainParent, "escape"), "secret");
    createWorktreeSymlinks(main, wt, ["../escape"]);
    expect(existsSync(join(wtParent, "escape"))).toBe(false);
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

describe("resolveReviveBranch", () => {
  const tempDirs: string[] = [];

  function git(args: string[], cwd: string): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  /** origin 無しの初期 commit 1 個 repo（default branch = main）。 */
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-revive-branch-"));
    tempDirs.push(dir);
    git(["init", "-b", "main"], dir);
    git(["config", "user.email", "t@example.com"], dir);
    git(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(["add", "."], dir);
    git(["commit", "-m", "first"], dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("candidate 空 → 日付ブランチを default(HEAD) から作成", async () => {
    const dir = makeRepo();
    const { branch, startPoint } = await resolveReviveBranch(dir, "");
    expect(branch).toMatch(/^\d{8}_\d{6}$/);
    expect(startPoint).toBe("main");
  });

  test("candidate が既存ローカルブランチ(未 checkout) → attach（startPoint 空）", async () => {
    const dir = makeRepo();
    git(["branch", "feature/foo"], dir);
    const { branch, startPoint } = await resolveReviveBranch(dir, "feature/foo");
    expect(branch).toBe("feature/foo");
    expect(startPoint).toBe("");
  });

  test("candidate が未存在 → その名前を default から作成", async () => {
    const dir = makeRepo();
    const { branch, startPoint } = await resolveReviveBranch(dir, "feature/new");
    expect(branch).toBe("feature/new");
    expect(startPoint).toBe("main");
  });

  test("candidate が他 worktree に checkout 済み → 日付ブランチへ倒す", async () => {
    const dir = makeRepo();
    git(["branch", "occupied"], dir);
    const parent = mkdtempSync(join(tmpdir(), "gozd-revive-occ-"));
    tempDirs.push(parent);
    // occupied を別 worktree で checkout（占有させる）。git が wt path を新規作成する
    git(["worktree", "add", join(parent, "wt"), "occupied"], dir);
    const { branch, startPoint } = await resolveReviveBranch(dir, "occupied");
    // generateTimestamp は同一秒内の連続呼び出しで連番 suffix を付ける (per-process 一意)
    expect(branch).toMatch(/^\d{8}_\d{6}(_\d+)?$/);
    expect(startPoint).toBe("main");
  });
});
