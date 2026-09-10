// worktree 書き込み系操作のテスト。
//
// createWorktreeSymlinks は git を要さない純 fs ロジックのため、main repo / worktree を模した
// 2 つの temp dir を直接操作して検証する。resolveReviveBranch と removeWorktree は git の判定
// そのものが対象なので、実 repo と実 worktree を作って検証する。

import { afterEach, describe, expect, test } from "bun:test";
import { tryCatch } from "@gozd/shared";
import { runFixtureGit } from "../testGitFixture";
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
import { createWorktreeSymlinks, removeWorktree, resolveReviveBranch } from "./worktreeOps";

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

  /** 日付ブランチ名。同一プロセスの先行呼び出しと秒が重なると generateTimestamp が
   * 連番 suffix を付けるため、両形を受ける */
  const dateBranch = /^\d{8}_\d{6}(_\d+)?$/;

  function git(args: string[], cwd: string): void {
    runFixtureGit(args, cwd);
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
    expect(branch).toMatch(dateBranch);
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
    expect(branch).toMatch(dateBranch);
    expect(startPoint).toBe("main");
  });
});

describe("removeWorktree (integration)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** 初期 commit 1 個の repo と、そこから生やした worktree 1 個 */
  function makeRepoWithWorktree(): { repo: string; wt: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "gozd-wt-remove-"));
    tempDirs.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    runFixtureGit(["init", "-b", "main"], repo);
    runFixtureGit(["config", "user.email", "t@example.com"], repo);
    runFixtureGit(["config", "user.name", "t"], repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    runFixtureGit(["add", "."], repo);
    runFixtureGit(["commit", "-m", "first"], repo);
    const wt = join(root, "wt");
    runFixtureGit(["worktree", "add", "-b", "feature", wt], repo);
    return { repo, wt, root };
  }

  /** 登録されている worktree の件数。main worktree を含むので clean な削除後は 1 */
  function worktreeCount(repo: string): number {
    return runFixtureGit(["worktree", "list", "--porcelain"], repo)
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length;
  }

  /** reject した Error を返す。`expect(...).rejects` は同期の後続 assertion と順序が付かず、
   * 「拒否時にファイルシステムがどうなっているか」を見る本 describe では待ち合わせが要る */
  async function rejection(promise: Promise<unknown>): Promise<Error> {
    const result = await tryCatch(promise);
    if (result.ok) throw new Error("expected rejection but resolved");
    return result.error;
  }

  test("clean な worktree は登録も実体も消える", async () => {
    const { repo, wt } = makeRepoWithWorktree();
    await removeWorktree(repo, wt, false);
    expect(existsSync(wt)).toBe(false);
    expect(worktreeCount(repo)).toBe(1);
  });

  test("実体が消えた stale 登録は登録だけ消える", async () => {
    const { repo, wt } = makeRepoWithWorktree();
    rmSync(wt, { recursive: true, force: true });
    await removeWorktree(repo, wt, false);
    expect(worktreeCount(repo)).toBe(1);
  });

  // 実体を退避してしまうと、後続の git は消えた repo を cwd に起動されて別の失敗になる。
  // git 由来のメッセージが返ることが「退避せず git へ渡した」ことの証拠になる
  test("main worktree は退避せず git へ渡して拒否させる", async () => {
    const { repo } = makeRepoWithWorktree();
    const error = await rejection(removeWorktree(repo, repo, false));
    expect(error.message).toMatch(/main working tree/);
    expect(existsSync(join(repo, "a.txt"))).toBe(true);
    expect(worktreeCount(repo)).toBe(2);
  });

  test("登録されていないディレクトリは退避せず git へ渡して拒否させる", async () => {
    const { repo, root } = makeRepoWithWorktree();
    const outsider = join(root, "outsider");
    mkdirSync(outsider);
    writeFileSync(join(outsider, "keep.txt"), "keep\n");
    const error = await rejection(removeWorktree(repo, outsider, false));
    expect(error.message).toMatch(/is not a working tree/);
    expect(existsSync(join(outsider, "keep.txt"))).toBe(true);
  });

  test("dirty な worktree は force なしで拒否し、実体を退避しない", async () => {
    const { repo, wt } = makeRepoWithWorktree();
    writeFileSync(join(wt, "a.txt"), "modified\n");
    const error = await rejection(removeWorktree(repo, wt, false));
    expect(error.message).toMatch(/modified or untracked/);
    expect(existsSync(wt)).toBe(true);
    expect(worktreeCount(repo)).toBe(2);
  });

  test("追跡外のファイルを持つ worktree は force なしで拒否する", async () => {
    const { repo, wt } = makeRepoWithWorktree();
    writeFileSync(join(wt, "scratch.txt"), "scratch\n");
    const error = await rejection(removeWorktree(repo, wt, false));
    expect(error.message).toMatch(/modified or untracked/);
    expect(existsSync(join(wt, "scratch.txt"))).toBe(true);
    expect(worktreeCount(repo)).toBe(2);
  });

  test("dirty な worktree も force なら消える", async () => {
    const { repo, wt } = makeRepoWithWorktree();
    writeFileSync(join(wt, "a.txt"), "modified\n");
    await removeWorktree(repo, wt, true);
    expect(existsSync(wt)).toBe(false);
    expect(worktreeCount(repo)).toBe(1);
  });

  /** worktree に submodule を 1 個追加する。追加した submodule の worktree 側パスを返す */
  function addSubmodule(root: string, wt: string): string {
    const sub = join(root, "sub");
    mkdirSync(sub);
    runFixtureGit(["init", "-b", "main"], sub);
    runFixtureGit(["config", "user.email", "t@example.com"], sub);
    runFixtureGit(["config", "user.name", "t"], sub);
    writeFileSync(join(sub, "s.txt"), "s\n");
    runFixtureGit(["add", "."], sub);
    runFixtureGit(["commit", "-m", "sub"], sub);
    // local path からの submodule 追加は protocol.file の明示許可が要る
    runFixtureGit(["-c", "protocol.file.allow=always", "submodule", "add", sub, "sub"], wt);
    runFixtureGit(["commit", "-m", "add submodule"], wt);
    return join(wt, "sub");
  }

  test("展開済み submodule を持つ worktree は force なしで拒否する", async () => {
    const { repo, wt, root } = makeRepoWithWorktree();
    addSubmodule(root, wt);
    const error = await rejection(removeWorktree(repo, wt, false));
    expect(error.message).toMatch(/contains submodules/);
    expect(existsSync(wt)).toBe(true);
    expect(worktreeCount(repo)).toBe(2);
  });

  // deinit は working tree 側だけを消し、submodule の object store は worktree の git dir に
  // 残る。status も submodule status も clean を返すため、git dir を見ないと通ってしまう
  test("deinit 済み submodule を持つ worktree は force なしで拒否する", async () => {
    const { repo, wt, root } = makeRepoWithWorktree();
    addSubmodule(root, wt);
    runFixtureGit(["submodule", "deinit", "-f", "sub"], wt);
    expect(runFixtureGit(["status", "--porcelain", "--ignore-submodules=none"], wt)).toBe("");
    const error = await rejection(removeWorktree(repo, wt, false));
    expect(error.message).toMatch(/contains submodules/);
    expect(existsSync(wt)).toBe(true);
    expect(worktreeCount(repo)).toBe(2);
  });

  test("git が拒否したら退避した実体を元の位置へ戻す", async () => {
    const { repo, wt } = makeRepoWithWorktree();
    // locked worktree は実体の有無に依らず git が拒否する（clean 判定は通過して rename まで進む）
    runFixtureGit(["worktree", "lock", wt], repo);
    const error = await rejection(removeWorktree(repo, wt, false));
    expect(error.message).toMatch(/locked/);
    expect(existsSync(join(wt, "a.txt"))).toBe(true);
    expect(worktreeCount(repo)).toBe(2);
  });
});
