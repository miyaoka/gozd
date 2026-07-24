import { describe, expect, test } from "bun:test";
import { createConcurrencyLimiter, isRepoFetchDue } from "./useRemoteFetchStore";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** factory 完了 → then(consumed) → consume が次を dequeue する microtask 連鎖を待つ */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createConcurrencyLimiter", () => {
  // fetch fan-out の本丸: 同時実行が cap を超えないこと（TLS 接続バーストを断つ根拠）
  test("同時実行数は cap を超えない", async () => {
    const limit = createConcurrencyLimiter<void>(2);
    let started = 0;
    let running = 0;
    let maxRunning = 0;
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const tasks = gates.map((gate) =>
      limit(async () => {
        started++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running--;
      }),
    );

    // 同期時点で cap ぶんの task だけが起動している（残りは queue で待機）
    expect(started).toBe(2);

    // 1 つ完了すると queue から次が 1 つだけ dequeue される
    gates[0].resolve();
    await tasks[0];
    await tick();
    expect(started).toBe(3);

    for (const gate of gates) gate.resolve();
    await Promise.all(tasks);
    expect(maxRunning).toBe(2);
  });

  test("task の解決値を呼び出し側へ透過する", async () => {
    const limit = createConcurrencyLimiter<number>(1);
    expect(await limit(async () => 42)).toBe(42);
  });

  test("task の reject を呼び出し側へ透過する", async () => {
    const limit = createConcurrencyLimiter<void>(1);
    let caught: unknown;
    await limit(async () => {
      throw new Error("boom");
    }).catch((error) => {
      caught = error;
    });
    expect((caught as Error).message).toBe("boom");
  });

  // 失敗経路でも slot を解放すること: hang/失敗した fetch が枠を永久占有すると新規 fetch が
  // 二度と走らなくなる（この修正の前提が崩れる）
  test("task が reject しても slot は解放され次が走る", async () => {
    const limit = createConcurrencyLimiter<void>(1);
    await limit(async () => {
      throw new Error("x");
    }).catch(() => {});
    let ran = false;
    await limit(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  // factory が Promise を返す前に同期 throw しても、reject 透過 + slot 解放が成立すること
  // (async で包まないと running が減らず cap 回累積で deadlock する)
  test("factory が同期 throw しても reject 透過 + slot 解放される", async () => {
    const limit = createConcurrencyLimiter<void>(1);
    let caught: unknown;
    await limit(() => {
      throw new Error("sync");
    }).catch((error) => {
      caught = error;
    });
    expect((caught as Error).message).toBe("sync");
    let ran = false;
    await limit(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("cap を超えた task は FIFO 順で実行される", async () => {
    const limit = createConcurrencyLimiter<void>(1);
    const order: number[] = [];
    const tasks = [0, 1, 2].map((i) =>
      limit(async () => {
        order.push(i);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2]);
  });
});
