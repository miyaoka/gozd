import { describe, expect, test } from "bun:test";
import { isRepoFetchDue } from "./useRemoteFetchStore";

const GIT_REPO = { isGitRepo: true };
const NON_GIT = { isGitRepo: false };
const NOW = 1_000_000;

describe("isRepoFetchDue", () => {
  test("focus 中 + lock 未設定 + git repo は対象", () => {
    expect(isRepoFetchDue({ repo: GIT_REPO, focused: true, allowedAt: undefined, now: NOW })).toBe(
      true,
    );
  });

  // 指摘の核: focus 喪失中は対象外。何も記録しないため focus 復帰で再判定され取りこぼしを救う
  test("focus 喪失中は git repo でも対象外", () => {
    expect(isRepoFetchDue({ repo: GIT_REPO, focused: false, allowedAt: undefined, now: NOW })).toBe(
      false,
    );
  });

  // focus false→true 遷移で同じ repo が対象に変わる = 起動時 focus 無しのリカバリ経路
  test("focus 復帰で同一 repo の判定が false → true に変わる", () => {
    const base = { repo: GIT_REPO, allowedAt: undefined, now: NOW };
    expect(isRepoFetchDue({ ...base, focused: false })).toBe(false);
    expect(isRepoFetchDue({ ...base, focused: true })).toBe(true);
  });

  test("backoff / lock 期間中 (allowedAt が未来) は対象外", () => {
    expect(isRepoFetchDue({ repo: GIT_REPO, focused: true, allowedAt: NOW + 1, now: NOW })).toBe(
      false,
    );
  });

  test("lock 期限が過ぎていれば対象", () => {
    expect(isRepoFetchDue({ repo: GIT_REPO, focused: true, allowedAt: NOW - 1, now: NOW })).toBe(
      true,
    );
  });

  test("非 git project は対象外", () => {
    expect(isRepoFetchDue({ repo: NON_GIT, focused: true, allowedAt: undefined, now: NOW })).toBe(
      false,
    );
  });

  test("未登録 repo (undefined) は対象外", () => {
    expect(isRepoFetchDue({ repo: undefined, focused: true, allowedAt: undefined, now: NOW })).toBe(
      false,
    );
  });

  // 複数 repo を述語で filter したとき、lock 既設 repo は外れ未設定 git repo だけ残る
  test("repo セットへの適用: lock 未設定の git repo だけが対象に残る", () => {
    const repos = [
      { dir: "/a", repo: GIT_REPO, allowedAt: undefined }, // 初回 → 対象
      { dir: "/b", repo: GIT_REPO, allowedAt: NOW + 1 }, // lock 中 → 除外
      { dir: "/c", repo: NON_GIT, allowedAt: undefined }, // 非 git → 除外
    ];
    const due = repos
      .filter((r) =>
        isRepoFetchDue({ repo: r.repo, focused: true, allowedAt: r.allowedAt, now: NOW }),
      )
      .map((r) => r.dir);
    expect(due).toEqual(["/a"]);
  });
});
