// 窓口の操作のテスト。削除の条件は git が返す worktree の登録と git の削除判定に依るので、
// 実 repo と実 worktree を作って検証する。
//
// 置いているのは、壊れても誰も気づかない性質だけ。
// - 削除の条件のうち concierge.ts が自分で判定するもの（稼働中のセッション・main worktree・
//   detached HEAD・worktree でないパス）と、強制しない削除を `removeWorktree` に渡すこと
// - セッションを開く dir が gozd の持つ表記で決まり、開けない dir では失敗すること
//
// 担保を他に置いている性質:
// - 要求元が窓口の端末でない要求の拒否は socketMessages.test.ts の「未登録の端末からの
//   worktreeRemove は理由付きの失敗を応答し、push しない」「窓口以外で開いた端末からの
//   worktreeRemove は拒否する」
// - 強制しない削除が変更中のファイル・submodule・lock を拒否することは git/worktreeOps.test.ts の
//   removeWorktree (integration)（「変更のあるファイルを持つ worktree は force なしで拒否する」ほか）

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tryCatch } from "@gozd/shared";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConciergeRemoveGuards,
  removeWorktreeForConcierge,
  resolveSessionOpenDir,
} from "./concierge";
import { resolveGitBeforeTests, runFixtureGit } from "./testGitFixture";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gozd-concierge-"));
  tempDirs.push(root);
  return root;
}

/** 初期 commit 1 個の repo と、そこから生やした worktree 1 個。窓口のディレクトリも並べて作る */
function makeFixture(): { repo: string; wt: string; concierge: string } {
  const root = makeTempRoot();
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
  const concierge = join(root, "concierge");
  mkdirSync(concierge);
  return { repo, wt, concierge };
}

function guards(concierge: string, overrides: Partial<ConciergeRemoveGuards> = {}) {
  return { conciergeDir: concierge, requesterDir: concierge, liveWorktreePaths: [], ...overrides };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const result = await tryCatch(promise);
  if (result.ok) throw new Error("expected rejection but resolved");
  return result.error;
}

describe("removeWorktreeForConcierge", () => {
  beforeAll(resolveGitBeforeTests);

  // concierge が強制しない削除を渡していることの担保。前段の判定が誤って拒否しても通らないよう、
  // 拒否の理由まで見る
  test("untracked のファイルがある worktree は拒否し、残る", async () => {
    const { wt, concierge } = makeFixture();
    writeFileSync(join(wt, "new.txt"), "new\n");
    const error = await rejection(removeWorktreeForConcierge(wt, guards(concierge)));
    expect(error.message).toContain("modified or untracked");
    expect(existsSync(join(wt, "new.txt"))).toBe(true);
  });

  test("稼働中のセッションがある worktree は拒否し、残る", async () => {
    const { wt, concierge } = makeFixture();
    const error = await rejection(
      removeWorktreeForConcierge(wt, guards(concierge, { liveWorktreePaths: [wt] })),
    );
    expect(error.message).toContain("running Claude session");
    expect(existsSync(wt)).toBe(true);
  });

  test("main worktree は拒否し、残る", async () => {
    const { repo, concierge } = makeFixture();
    const error = await rejection(removeWorktreeForConcierge(repo, guards(concierge)));
    expect(error.message).toContain("main worktree");
    expect(existsSync(join(repo, "a.txt"))).toBe(true);
  });

  test("detached HEAD の worktree は拒否し、残る", async () => {
    const { wt, concierge } = makeFixture();
    runFixtureGit(["checkout", "--detach"], wt);
    const error = await rejection(removeWorktreeForConcierge(wt, guards(concierge)));
    expect(error.message).toContain("detached HEAD");
    expect(existsSync(wt)).toBe(true);
  });

  test("worktree でないパスは拒否し、実体に触れない", async () => {
    const { repo, concierge } = makeFixture();
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const error = await rejection(removeWorktreeForConcierge(sub, guards(concierge)));
    expect(error.message).toContain("not a worktree");
    expect(existsSync(sub)).toBe(true);
  });
});

describe("resolveSessionOpenDir", () => {
  const openDirs = new Set(["/repo", "/repo/wt"]);

  test("端末が開いているセッションは、その端末の dir で開く", () => {
    const dir = resolveSessionOpenDir("s1", {
      liveSessions: [{ sessionId: "s1", worktreePath: "/repo/wt" }],
      cwd: "/repo/wt/sub",
      openDirs,
    });
    expect(dir).toBe("/repo/wt");
  });

  test("シンボリックリンク越しの作業ディレクトリは、gozd が持つ表記で返す", () => {
    const root = makeTempRoot();
    const wt = join(root, "wt");
    mkdirSync(wt);
    const link = join(root, "link");
    symlinkSync(wt, link);
    const dir = resolveSessionOpenDir("s1", {
      liveSessions: [],
      cwd: link,
      openDirs: new Set([wt]),
    });
    expect(dir).toBe(wt);
  });

  test("gozd で開いていない dir のセッションは開けない", () => {
    expect(() =>
      resolveSessionOpenDir("s1", { liveSessions: [], cwd: "/elsewhere", openDirs }),
    ).toThrow("not open in gozd");
  });
});
