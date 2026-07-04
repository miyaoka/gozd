// classify の pure unit test。Swift 版 `FSWatchRegistryTests.swift` の
// `ClassifyTests`（pure 部）を bun test に移植したもの。ケース名・fixture を対で維持し、
// 両シェルの分類契約が一致していることをテスト名の突合で確認できるようにする。

import { describe, expect, test } from "bun:test";
import { classify } from "./classify";

describe("classify (worktree 配置)", () => {
  const dir = "/wt/foo";
  const perWt = "/parent/.git/worktrees/foo";
  const common = "/parent/.git";

  test("secondary 自身の per-worktree HEAD は gitStatusChange のみ（worktreeChange は root watcher が担う）", () => {
    // perWtSameAsCommon == false の secondary watcher。自身の HEAD 変化で worktreeChange を
    // 立てると root watcher (common 規則 `worktrees/...`) と二重発火するため立てない
    const result = classify({
      dir,
      perWorktreeGitDir: perWt,
      commonGitDir: common,
      paths: ["/parent/.git/worktrees/foo/HEAD"],
    });
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasFsChange).toBe(false);
    expect(result.hasBranchChange).toBe(false);
    expect(result.hasWorktreeChange).toBe(false);
  });

  test("common git dir 配下の refs/heads/main は branchChange", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: perWt,
      commonGitDir: common,
      paths: ["/parent/.git/refs/heads/main"],
    });
    expect(result.hasBranchChange).toBe(true);
    expect(result.hasFsChange).toBe(false);
    expect(result.hasGitStatusChange).toBe(false);
    expect(result.hasWorktreeChange).toBe(false);
  });

  test("common git dir 配下の packed-refs は branchChange + gitStatusChange", () => {
    // packed-refs は local ref と remote-tracking ref のどちらの pack かファイル名から
    // 判別不能なので両 subscriber に通知する
    const result = classify({
      dir,
      perWorktreeGitDir: perWt,
      commonGitDir: common,
      paths: ["/parent/.git/packed-refs"],
    });
    expect(result.hasBranchChange).toBe(true);
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasFsChange).toBe(false);
    expect(result.hasWorktreeChange).toBe(false);
  });

  test("common git dir 配下の refs/remotes/origin/main は gitStatusChange + remoteRefsChange", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: perWt,
      commonGitDir: common,
      paths: ["/parent/.git/refs/remotes/origin/main"],
    });
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasRemoteRefsChange).toBe(true);
    expect(result.hasBranchChange).toBe(false);
    expect(result.hasFsChange).toBe(false);
    expect(result.hasWorktreeChange).toBe(false);
  });

  test("refs/remotes/origin/HEAD（symbolic ref）も gitStatusChange + remoteRefsChange", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: perWt,
      commonGitDir: common,
      paths: ["/parent/.git/refs/remotes/origin/HEAD"],
    });
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasRemoteRefsChange).toBe(true);
    expect(result.hasBranchChange).toBe(false);
  });

  test("branch 名にスラッシュを含む refs/remotes/origin/feature/sub も gitStatusChange + remoteRefsChange", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: perWt,
      commonGitDir: common,
      paths: ["/parent/.git/refs/remotes/origin/feature/sub"],
    });
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasRemoteRefsChange).toBe(true);
    expect(result.hasBranchChange).toBe(false);
  });

  test("refs/tags/ は意図的に silent drop（未対応 ref 種別）", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: perWt,
      commonGitDir: common,
      paths: ["/parent/.git/refs/tags/v1.0.0"],
    });
    expect(result.hasGitStatusChange).toBe(false);
    expect(result.hasBranchChange).toBe(false);
    expect(result.hasFsChange).toBe(false);
    expect(result.hasWorktreeChange).toBe(false);
  });

  test("兄弟 worktree の worktrees/<other> 追加は worktreeChange", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: perWt,
      commonGitDir: common,
      paths: ["/parent/.git/worktrees/bar/HEAD"],
    });
    expect(result.hasWorktreeChange).toBe(true);
    expect(result.hasGitStatusChange).toBe(false);
  });

  test("自身の per-wt 内部 (例: locked) は worktreeChange を発火させない", () => {
    // `<common>/worktrees/foo/locked` は per-wt git dir 配下なので per-wt 規則のみ適用
    const result = classify({
      dir,
      perWorktreeGitDir: perWt,
      commonGitDir: common,
      paths: ["/parent/.git/worktrees/foo/locked"],
    });
    expect(result.hasWorktreeChange).toBe(false);
    expect(result.hasGitStatusChange).toBe(false);
  });

  test("作業ツリー配下のファイルは fsChange + gitStatusChange", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: perWt,
      commonGitDir: common,
      paths: ["/wt/foo/src/a.ts"],
    });
    expect(result.hasFsChange).toBe(true);
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.fsRelDirs).toEqual(new Set(["src"]));
  });
});

describe("classify (通常 clone)", () => {
  const dir = "/repo";
  const gitDir = "/repo/.git";

  test("per-worktree == common == <dir>/.git でも HEAD と refs/heads が両方分類される", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: gitDir,
      commonGitDir: gitDir,
      paths: ["/repo/.git/HEAD", "/repo/.git/refs/heads/main"],
    });
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasBranchChange).toBe(true);
    // HEAD は perWtSameAsCommon (= root / main worktree) なので headChange 候補も立つ
    expect(result.hasHeadChange).toBe(true);
    expect(result.hasWorktreeChange).toBe(false);
    // 通常 clone でも .git 配下は作業ツリー判定に乗せない
    expect(result.hasFsChange).toBe(false);
  });

  test(".git/HEAD 単独変化は gitStatusChange + headChange（branchChange / worktreeChange は伴わない）", () => {
    // `git switch existing-branch` を root で実行した状況。HEAD で headChange 候補を立てないと
    // dispatch の digest gating が worktreeChange を発火できず、サイドバーの branch label が
    // 古いまま残る
    const result = classify({
      dir,
      perWorktreeGitDir: gitDir,
      commonGitDir: gitDir,
      paths: ["/repo/.git/HEAD"],
    });
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasHeadChange).toBe(true);
    expect(result.hasWorktreeChange).toBe(false);
    expect(result.hasBranchChange).toBe(false);
    expect(result.hasFsChange).toBe(false);
  });

  test(".git/index 単独変化は gitStatusChange のみ（worktreeChange は立たない）", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: gitDir,
      commonGitDir: gitDir,
      paths: ["/repo/.git/index"],
    });
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasWorktreeChange).toBe(false);
    expect(result.hasBranchChange).toBe(false);
    expect(result.hasFsChange).toBe(false);
  });

  test(".git 配下の関心外ファイル（objects/）は何も発火させない", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: gitDir,
      commonGitDir: gitDir,
      paths: ["/repo/.git/objects/ab/cdef"],
    });
    expect(result.hasFsChange).toBe(false);
    expect(result.hasGitStatusChange).toBe(false);
    expect(result.hasBranchChange).toBe(false);
    expect(result.hasWorktreeChange).toBe(false);
  });

  test("packed-refs 変更で branchChange + gitStatusChange + remoteRefsChange が立つ", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: gitDir,
      commonGitDir: gitDir,
      paths: ["/repo/.git/packed-refs"],
    });
    expect(result.hasBranchChange).toBe(true);
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasRemoteRefsChange).toBe(true);
  });

  test("dir 配下でも git dir 配下でもない event は無視", () => {
    const result = classify({
      dir,
      perWorktreeGitDir: gitDir,
      commonGitDir: gitDir,
      paths: ["/elsewhere/x.txt"],
    });
    expect(result.hasFsChange).toBe(false);
    expect(result.hasGitStatusChange).toBe(false);
  });
});

describe("classify (非 git dir)", () => {
  test("作業ツリー配下のファイルは fsChange のみ（gitStatusChange は立てない）", () => {
    // commonGitDir === undefined は非 git dir の watch (session log dialog 等)。
    // git status の概念が無いため gitStatusChange を立てない
    const result = classify({
      dir: "/somewhere",
      perWorktreeGitDir: undefined,
      commonGitDir: undefined,
      paths: ["/somewhere/note.txt"],
    });
    expect(result.hasFsChange).toBe(true);
    expect(result.hasGitStatusChange).toBe(false);
    expect(result.fsRelDirs).toEqual(new Set([""]));
  });
});

describe("classify (reftable backend)", () => {
  test("root: .git/reftable/tables.list 変化は branch + remote + status + head 候補（packed-refs + HEAD と等価）", () => {
    // reftable では HEAD スタブが固定で動かず、branch 切替・作成・削除・rename・fetch が
    // すべて共有テーブルの書き換えに funnel される。実際にどのカテゴリが動いたかは
    // dispatch の RefDigest 内容比較が確定する
    const result = classify({
      dir: "/repo",
      perWorktreeGitDir: "/repo/.git",
      commonGitDir: "/repo/.git",
      paths: ["/repo/.git/reftable/tables.list"],
    });
    expect(result.hasBranchChange).toBe(true);
    expect(result.hasRemoteRefsChange).toBe(true);
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasHeadChange).toBe(true);
    expect(result.hasWorktreeChange).toBe(false);
    expect(result.hasFsChange).toBe(false);
  });

  test("secondary 自身: per-wt reftable 変化は gitStatusChange のみ（worktreeChange は root watcher が担う）", () => {
    const result = classify({
      dir: "/wt/foo",
      perWorktreeGitDir: "/parent/.git/worktrees/foo",
      commonGitDir: "/parent/.git",
      paths: ["/parent/.git/worktrees/foo/reftable/tables.list"],
    });
    expect(result.hasGitStatusChange).toBe(true);
    expect(result.hasBranchChange).toBe(false);
    expect(result.hasRemoteRefsChange).toBe(false);
    expect(result.hasWorktreeChange).toBe(false);
    expect(result.hasFsChange).toBe(false);
  });

  test("root watcher から見た secondary の per-wt reftable 変化は worktreeChange", () => {
    const result = classify({
      dir: "/repo",
      perWorktreeGitDir: "/repo/.git",
      commonGitDir: "/repo/.git",
      paths: ["/repo/.git/worktrees/foo/reftable/tables.list"],
    });
    expect(result.hasWorktreeChange).toBe(true);
    expect(result.hasBranchChange).toBe(false);
    expect(result.hasRemoteRefsChange).toBe(false);
    expect(result.hasGitStatusChange).toBe(false);
    expect(result.hasHeadChange).toBe(false);
    expect(result.hasFsChange).toBe(false);
  });
});
