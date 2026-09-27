// worktree 書き込み系操作のうち、壊れても利用者が気づけない性質だけを検証する。
//
// createWorktreeSymlinks は git を要さない純 fs ロジックのため、main repo / worktree を模した
// 2 つの temp dir を直接操作して検証する。resolveReviveBranch と removeWorktree は、判定の入力が
// 実 repo の ref・worktree の登録・working tree の状態なので、実 repo と実 worktree を作って検証する。

import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { tryCatch } from "@gozd/shared";
import { runFixtureGit } from "../testGitFixture";
import { resolveGitBeforeTests } from "../testGitResolver";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeSymlinks, removeWorktree, resolveReviveBranch } from "./worktreeOps";

beforeAll(resolveGitBeforeTests);

/** 初期 commit 1 個の repo（default branch = main）を dir に作る */
function initRepo(dir: string): void {
  runFixtureGit(["init", "-b", "main"], dir);
  runFixtureGit(["config", "user.email", "t@example.com"], dir);
  runFixtureGit(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "a.txt"), "a\n");
  runFixtureGit(["add", "."], dir);
  runFixtureGit(["commit", "-m", "first"], dir);
}

describe("createWorktreeSymlinks", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // 張られないと worktree 側は main repo のローカル設定（`.claude/` 等）を黙って欠く。失敗は
  // main の観察ログにしか出ない。親ディレクトリの作成と symlink の作成の両方をこのテストが担う
  test("nested target は dest 親ディレクトリを作って main repo 側への symlink を張る", () => {
    const main = mkdtempSync(join(tmpdir(), "gozd-symlink-main-"));
    const wt = mkdtempSync(join(tmpdir(), "gozd-symlink-wt-"));
    tempDirs.push(main, wt);
    mkdirSync(join(main, ".config"));
    writeFileSync(join(main, ".config", "app.json"), "{}");
    createWorktreeSymlinks(main, wt, [".config/app.json"]);
    const dest = join(wt, ".config", "app.json");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(join(main, ".config", "app.json"));
  });

  // containment が崩れると、`..` を含む設定から worktree の外に symlink が黙って作られる
  test("`..` traversal target は worktree の外に symlink を張らない", () => {
    // main と wt を別々の親 dir 配下に置き、`..` の脱出先を各親に用意する。containment が
    // 無効なら source=mainParent/escape を dest=wtParent/escape に張るため、脱出先が
    // 作られないことで、source 不在による skip と区別して拒否を示せる
    const mainParent = mkdtempSync(join(tmpdir(), "gozd-symlink-mainp-"));
    const wtParent = mkdtempSync(join(tmpdir(), "gozd-symlink-wtp-"));
    tempDirs.push(mainParent, wtParent);
    const main = join(mainParent, "repo");
    const wt = join(wtParent, "repo");
    mkdirSync(main);
    mkdirSync(wt);
    writeFileSync(join(mainParent, "escape"), "secret");
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    createWorktreeSymlinks(main, wt, ["../escape"]);
    const logged = consoleError.mock.calls.map(([message]) => String(message));
    consoleError.mockRestore();
    expect(existsSync(join(wtParent, "escape"))).toBe(false);
    // 拒否は観察ログにしか現れない
    expect(logged).toEqual(["[createWorktreeSymlinks] rejected traversal target=../escape"]);
  });
});

describe("resolveReviveBranch", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // 既存ブランチに startPoint を付けると createWorktree が `-B` で default へ reset し、
  // そのブランチだけにあった commit が到達不能になる
  test("candidate が既存ローカルブランチ(未 checkout) → attach（startPoint 空）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-revive-branch-"));
    tempDirs.push(dir);
    initRepo(dir);
    runFixtureGit(["branch", "feature/foo"], dir);
    const { branch, startPoint } = await resolveReviveBranch(dir, "feature/foo");
    expect(branch).toBe("feature/foo");
    expect(startPoint).toBe("");
  });
});

// 非 force の削除が拒否すべき worktree を通すと、実体は切り離した rm に渡って戻らない。
// git の check_clean_worktree / validate_no_submodules を退避前に肩代わりしている部分なので、
// git の判定と同じ拒否条件をここで固定する
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
    initRepo(repo);
    const wt = join(root, "wt");
    runFixtureGit(["worktree", "add", "-b", "feature", wt], repo);
    return { repo, wt, root };
  }

  /** 登録されている worktree の件数。main worktree を含む */
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

  test("変更のあるファイルを持つ worktree は force なしで拒否する", async () => {
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

  // git dir を working tree 内に持つ submodule（既存 repo を submodule として追加した形）。
  // worktree の git dir に `modules` が無いため、展開済みの判定（`submodule status`）だけが
  // 拒否の根拠になる。消えるとその submodule の未 push の commit ごと失われる
  test("git dir を working tree 内に持つ submodule を持つ worktree は force なしで拒否する", async () => {
    const { repo, wt } = makeRepoWithWorktree();
    const sub = join(wt, "sub");
    mkdirSync(sub);
    initRepo(sub);
    runFixtureGit(["submodule", "add", sub, "sub"], wt);
    runFixtureGit(["commit", "-m", "add submodule"], wt);
    const gitDir = runFixtureGit(["rev-parse", "--absolute-git-dir"], wt);
    expect(existsSync(join(gitDir, "modules"))).toBe(false);
    const error = await rejection(removeWorktree(repo, wt, false));
    expect(error.message).toMatch(/contains submodules/);
    expect(existsSync(join(sub, "a.txt"))).toBe(true);
    expect(worktreeCount(repo)).toBe(2);
  });

  // deinit は working tree 側だけを消し、submodule の object store は worktree の git dir に
  // 残る。status も submodule status も clean を返すため、git dir を見ないと通ってしまう
  test("deinit 済み submodule を持つ worktree は force なしで拒否する", async () => {
    const { repo, wt, root } = makeRepoWithWorktree();
    const sub = join(root, "sub");
    mkdirSync(sub);
    initRepo(sub);
    // local path からの submodule 追加は protocol.file の明示許可が要る
    runFixtureGit(["-c", "protocol.file.allow=always", "submodule", "add", sub, "sub"], wt);
    runFixtureGit(["commit", "-m", "add submodule"], wt);
    runFixtureGit(["submodule", "deinit", "-f", "sub"], wt);
    expect(runFixtureGit(["status", "--porcelain", "--ignore-submodules=none"], wt)).toBe("");
    const error = await rejection(removeWorktree(repo, wt, false));
    expect(error.message).toMatch(/contains submodules/);
    expect(existsSync(wt)).toBe(true);
    expect(worktreeCount(repo)).toBe(2);
  });

  // 戻さないと実体は退避先の隠しディレクトリに残り、元のパスから消える
  test("git が拒否したら退避した実体を元の位置へ戻す", async () => {
    const { repo } = makeRepoWithWorktree();
    // main worktree の中の追跡済みディレクトリは、clean 判定を通って退避まで進み、worktree として
    // 登録されていないので git が拒否する
    const sub = join(repo, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "s.txt"), "s\n");
    runFixtureGit(["add", "."], repo);
    runFixtureGit(["commit", "-m", "add sub"], repo);
    const error = await rejection(removeWorktree(repo, sub, false));
    expect(error.message).toMatch(/is not a working tree/);
    expect(existsSync(join(sub, "s.txt"))).toBe(true);
  });

  // lock の持ち主は worktree を使用中で、拒否までの間でも作業場所が消えると持ち主の作業が壊れる。
  // 理由なしの lock は `locked` が空で、理由の有無で lock の判定が分かれてはならない
  test.each([
    {
      label: "with reason",
      lockArgs: ["--reason", "agent running"],
      message: /is locked, lock reason: agent running$/,
    },
    { label: "without reason", lockArgs: [], message: /is locked$/ },
  ])(
    "lock された worktree は、実体を動かさずに force なしで拒否する: $label",
    async ({ lockArgs, message }) => {
      const { repo, wt } = makeRepoWithWorktree();
      runFixtureGit(["worktree", "lock", ...lockArgs, wt], repo);
      const rename = spyOn(fs, "renameSync");
      const error = await rejection(removeWorktree(repo, wt, false));
      const renamed = rename.mock.calls.length;
      rename.mockRestore();
      expect(error.message).toMatch(message);
      expect(renamed).toBe(0);
      expect(existsSync(join(wt, "a.txt"))).toBe(true);
      expect(worktreeCount(repo)).toBe(2);
    },
  );
});
