import { describe, expect, test } from "bun:test";
import { isFailureNotifyDue, isRepoFetchDue } from "./useRemoteFetchStore";

const GIT_REPO = { isGitRepo: true };
const NON_GIT = { isGitRepo: false };
const NOW = 1_000_000;

describe("isRepoFetchDue", () => {
  test("lock 未設定 + git repo は対象", () => {
    expect(isRepoFetchDue({ repo: GIT_REPO, allowedAt: undefined, now: NOW })).toBe(true);
  });

  test("backoff / lock 期間中 (allowedAt が未来) は対象外", () => {
    expect(isRepoFetchDue({ repo: GIT_REPO, allowedAt: NOW + 1, now: NOW })).toBe(false);
  });

  test("lock 期限が過ぎていれば対象", () => {
    expect(isRepoFetchDue({ repo: GIT_REPO, allowedAt: NOW - 1, now: NOW })).toBe(true);
  });

  // 境界: lock 期限ちょうど (now === allowedAt) は抜けたとみなす (now < allowedAt でないため)
  test("lock 期限ちょうどは対象", () => {
    expect(isRepoFetchDue({ repo: GIT_REPO, allowedAt: NOW, now: NOW })).toBe(true);
  });

  test("非 git project は対象外", () => {
    expect(isRepoFetchDue({ repo: NON_GIT, allowedAt: undefined, now: NOW })).toBe(false);
  });

  test("未登録 repo (undefined) は対象外", () => {
    expect(isRepoFetchDue({ repo: undefined, allowedAt: undefined, now: NOW })).toBe(false);
  });

  // 複数 repo を述語で filter したとき、lock 既設 repo は外れ未設定 git repo だけ残る
  test("repo セットへの適用: lock 未設定の git repo だけが対象に残る", () => {
    const repos = [
      { dir: "/a", repo: GIT_REPO, allowedAt: undefined }, // 初回 → 対象
      { dir: "/b", repo: GIT_REPO, allowedAt: NOW + 1 }, // lock 中 → 除外
      { dir: "/c", repo: NON_GIT, allowedAt: undefined }, // 非 git → 除外
    ];
    const due = repos
      .filter((r) => isRepoFetchDue({ repo: r.repo, allowedAt: r.allowedAt, now: NOW }))
      .map((r) => r.dir);
    expect(due).toEqual(["/a"]);
  });
});

describe("isFailureNotifyDue", () => {
  // 30 分 = FAILURE_NOTIFY_INTERVAL_MS。expected をリテラルで固定し、定数変更を明示的な行為にする
  const INTERVAL = 30 * 60_000;

  test("前回通知が無い (失敗エピソードの先頭) なら通知する", () => {
    expect(isFailureNotifyDue({ lastNotifiedAt: undefined, now: NOW })).toBe(true);
  });

  test("最小間隔未満は間引く", () => {
    expect(isFailureNotifyDue({ lastNotifiedAt: NOW - INTERVAL + 1, now: NOW })).toBe(false);
  });

  test("最小間隔ちょうどで通知に戻る", () => {
    expect(isFailureNotifyDue({ lastNotifiedAt: NOW - INTERVAL, now: NOW })).toBe(true);
  });
});
