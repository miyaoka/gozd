import type { WorktreeEntry } from "@gozd/proto";
import { describe, expect, test } from "bun:test";
import { collectFsWatchTargetDirs, type RepoState } from "../../shared/repo";
import { runOneSyncPass, type SyncPassDeps } from "./runOneSyncPass";

function wt(path: string, branch: string, isMain = false): WorktreeEntry {
  return { path, head: "", branch, isMain, gitStatuses: {}, tasks: [] };
}

/**
 * トーストに渡された aggregate Error の cause chain を解く。
 * `notify.error(message, aggregate)` で aggregate が Error として渡され、その `cause`
 * に first failure の Error が入っている前提で展開する。`as` キャストを避けるため
 * `instanceof Error` で narrowing する。
 */
function expectAggregate(cause: unknown): { aggregate: Error; first: Error } {
  if (!(cause instanceof Error)) throw new Error(`expected Error, got ${typeof cause}`);
  if (!(cause.cause instanceof Error)) {
    throw new Error(`expected Error in cause.cause, got ${typeof cause.cause}`);
  }
  return { aggregate: cause, first: cause.cause };
}

interface CallRecord {
  watch: string[];
  unwatch: string[];
  /** `fsWatchReady` が発射された dir の列 (発射順)。dir 1 件につき 1 push の契約。 */
  ready: string[];
  errors: Array<{ message: string; cause: unknown }>;
}

interface FixtureOptions {
  store: { dirOrder: string[]; repos: Record<string, RepoState> };
  watchedDirs?: Set<string>;
  failWatch?: Set<string>;
  failUnwatch?: Set<string>;
}

function makeFixture(opts: FixtureOptions): { deps: SyncPassDeps; calls: CallRecord } {
  const calls: CallRecord = { watch: [], unwatch: [], ready: [], errors: [] };
  const failWatch = opts.failWatch ?? new Set<string>();
  const failUnwatch = opts.failUnwatch ?? new Set<string>();
  const deps: SyncPassDeps = {
    targetDirs: collectFsWatchTargetDirs(opts.store.dirOrder, opts.store.repos),
    watchedDirs: opts.watchedDirs ?? new Set(),
    fsWatch: async ({ dir }) => {
      calls.watch.push(dir);
      if (failWatch.has(dir)) throw new Error(`watch failed: ${dir}`);
      return {};
    },
    fsUnwatch: async ({ dir }) => {
      calls.unwatch.push(dir);
      if (failUnwatch.has(dir)) throw new Error(`unwatch failed: ${dir}`);
      return {};
    },
    notify: {
      error: (message, cause) => calls.errors.push({ message, cause }),
    },
    dispatchReady: (dir) => {
      calls.ready.push(dir);
    },
  };
  return { deps, calls };
}

describe("runOneSyncPass", () => {
  test("初回 sync で全 target を watch し、fsWatchReady を dir ごとに 1 回ずつ発射する", async () => {
    const { deps, calls } = makeFixture({
      store: {
        dirOrder: ["/r1"],
        repos: {
          "/r1": {
            rootDir: "/r1",
            repoName: "r1",
            isGitRepo: true,
            worktrees: [wt("/r1", "main", true), wt("/r1/wt-a", "feat-a")],
          },
        },
      },
    });
    await runOneSyncPass(deps);
    expect(calls.watch).toEqual(["/r1", "/r1/wt-a"]);
    expect(calls.unwatch).toEqual([]);
    expect(calls.ready).toEqual(["/r1", "/r1/wt-a"]);
    expect(calls.errors).toEqual([]);
    expect(deps.watchedDirs).toEqual(new Set(["/r1", "/r1/wt-a"]));
  });

  test("target から消えた dir を unwatch して watchedDirs から除く", async () => {
    const { deps, calls } = makeFixture({
      store: {
        dirOrder: ["/r1"],
        repos: {
          "/r1": {
            rootDir: "/r1",
            repoName: "r1",
            isGitRepo: true,
            worktrees: [wt("/r1", "main", true)],
          },
        },
      },
      watchedDirs: new Set(["/r1", "/r1/wt-removed"]),
    });
    await runOneSyncPass(deps);
    expect(calls.unwatch).toEqual(["/r1/wt-removed"]);
    expect(calls.watch).toEqual([]);
    // 新規 watch ゼロのため Ready を発射しない
    expect(calls.ready).toEqual([]);
    expect(deps.watchedDirs).toEqual(new Set(["/r1"]));
  });

  test("全 watch が失敗すると fsWatchReady を発射せず、aggregate Error をトーストする", async () => {
    const { deps, calls } = makeFixture({
      store: {
        dirOrder: ["/r1"],
        repos: {
          "/r1": {
            rootDir: "/r1",
            repoName: "r1",
            isGitRepo: true,
            worktrees: [wt("/r1", "main", true)],
          },
        },
      },
      failWatch: new Set(["/r1"]),
    });
    await runOneSyncPass(deps);
    expect(calls.ready).toEqual([]);
    expect(calls.errors.length).toBe(1);
    expect(deps.watchedDirs.has("/r1")).toBe(false);
    const [err] = calls.errors;
    expect(err.message).toBe("Failed to sync FS watches (1)");
    const { aggregate, first } = expectAggregate(err.cause);
    expect(aggregate.message).toBe("watch:/r1");
    expect(first.message).toBe("watch failed: /r1");
  });

  test("一部 watch のみ失敗した場合、aggregate に件数と first.error が乗り、Ready は発射する", async () => {
    const { deps, calls } = makeFixture({
      store: {
        dirOrder: ["/r1"],
        repos: {
          "/r1": {
            rootDir: "/r1",
            repoName: "r1",
            isGitRepo: true,
            worktrees: [wt("/r1", "main", true), wt("/r1/wt-a", "feat-a")],
          },
        },
      },
      failWatch: new Set(["/r1/wt-a"]),
    });
    await runOneSyncPass(deps);
    expect(deps.watchedDirs).toEqual(new Set(["/r1"]));
    // 成功した /r1 についてのみ Ready を発射 (失敗した /r1/wt-a については発射しない)
    expect(calls.ready).toEqual(["/r1"]);
    expect(calls.errors.length).toBe(1);
    const [err] = calls.errors;
    expect(err.message).toBe("Failed to sync FS watches (1)");
    const { aggregate, first } = expectAggregate(err.cause);
    // aggregate.message は summary のみ。first error の name/message/stack は cause 経由で
    // `formatCauseChain` がトースト詳細に再帰展開する（toast UI 側の責務）
    expect(aggregate.message).toBe("watch:/r1/wt-a");
    expect(first.message).toBe("watch failed: /r1/wt-a");
  });

  test("unwatch 失敗でも watchedDirs からは削除される (再 watch / unwatchAll で leak は閉じる)", async () => {
    const { deps, calls } = makeFixture({
      store: {
        dirOrder: ["/r1"],
        repos: {
          "/r1": {
            rootDir: "/r1",
            repoName: "r1",
            isGitRepo: true,
            worktrees: [wt("/r1", "main", true)],
          },
        },
      },
      watchedDirs: new Set(["/r1", "/r1/wt-removed"]),
      failUnwatch: new Set(["/r1/wt-removed"]),
    });
    await runOneSyncPass(deps);
    expect(calls.unwatch).toEqual(["/r1/wt-removed"]);
    expect(deps.watchedDirs).toEqual(new Set(["/r1"]));
    expect(calls.errors.length).toBe(1);
    expect(calls.errors[0].message).toBe("Failed to sync FS watches (1)");
  });

  test("watch / unwatch 両方失敗した場合、aggregate に first error として最初の failure が乗る", async () => {
    const { deps, calls } = makeFixture({
      store: {
        dirOrder: ["/r1"],
        repos: {
          "/r1": {
            rootDir: "/r1",
            repoName: "r1",
            isGitRepo: true,
            worktrees: [wt("/r1/wt-new", "feat-a")],
          },
        },
      },
      watchedDirs: new Set(["/r1/wt-removed"]),
      failWatch: new Set(["/r1/wt-new"]),
      failUnwatch: new Set(["/r1/wt-removed"]),
    });
    await runOneSyncPass(deps);
    expect(calls.errors.length).toBe(1);
    const [err] = calls.errors;
    expect(err.message).toBe("Failed to sync FS watches (2)");
    const { aggregate, first } = expectAggregate(err.cause);
    // unwatch が watch より先に実行されるため、first.error は unwatch failure
    expect(aggregate.message).toBe("unwatch:/r1/wt-removed, watch:/r1/wt-new");
    expect(first.message).toBe("unwatch failed: /r1/wt-removed");
  });

  test("差分ゼロでは何も発射しない (toWatch / toUnwatch どちらも空)", async () => {
    const { deps, calls } = makeFixture({
      store: {
        dirOrder: ["/r1"],
        repos: {
          "/r1": {
            rootDir: "/r1",
            repoName: "r1",
            isGitRepo: true,
            worktrees: [wt("/r1", "main", true)],
          },
        },
      },
      watchedDirs: new Set(["/r1"]),
    });
    await runOneSyncPass(deps);
    expect(calls.watch).toEqual([]);
    expect(calls.unwatch).toEqual([]);
    expect(calls.ready).toEqual([]);
    expect(calls.errors).toEqual([]);
    expect(deps.watchedDirs).toEqual(new Set(["/r1"]));
  });
});
