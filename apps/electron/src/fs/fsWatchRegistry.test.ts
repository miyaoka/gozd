// FSWatchRegistry のうち、壊れても利用者が気づけない性質を検証する。
//
// transport と statusFetcher を差し替え、テストが時間を待たずに進行を握る。
// - transport: subscribe に渡された callback を捕まえ、event path をテストから直接流す。
//   fsChange の配送は callback の呼び出しと同期に起きる
// - statusFetcher: 呼び出しを捕まえ、結果を返す時点をテストが決める。取得は dir ごとに直列なので、
//   N+1 回目の取得が始まった時点で N 回目の取得と push の判定は終わっている
//
// event path の分類は classify.test.ts が担保する。入れ子 worktree として扱う entry の選別
// （nestedWorktreeDirsOf）はテストを持たない。選別を壊すと status の取得が起きないか余分に起きる
// だけで、待つべき呼び出しが訪れず、時間切れでしか落とせない。

import { afterEach, beforeAll, expect, test } from "bun:test";
import { tryCatch } from "@gozd/shared";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusFull } from "../git/porcelain";
import { runFixtureGit } from "../testGitFixture";
import { resolveGitBeforeTests } from "../testGitResolver";
import {
  createFsWatchRegistry,
  type FsWatchHandlers,
  type WatchTransport,
} from "./fsWatchRegistry";

interface FakeSubscription {
  root: string;
  ignore: string[];
  onEvents: (paths: string[]) => void;
  unsubscribed: boolean;
}

/** `shouldFail` が真を返した subscribe は失敗させる（native 側の subscribe 失敗の代わり） */
function createFakeTransport(
  shouldFail: (root: string, ignore: string[]) => boolean = () => false,
) {
  const subscriptions: FakeSubscription[] = [];
  /** subscribe（`+root`）と unsubscribe（`-root`）を起きた順に記録する */
  const log: string[] = [];
  const transport: WatchTransport = {
    async subscribe(root, ignore, onEvents) {
      if (shouldFail(root, ignore)) throw new Error(`subscribe failed: ${root}`);
      const subscription: FakeSubscription = { root, ignore, onEvents, unsubscribed: false };
      subscriptions.push(subscription);
      log.push(`+${root}`);
      return {
        async unsubscribe() {
          subscription.unsubscribed = true;
          log.push(`-${root}`);
        },
      };
    },
  };
  return { transport, subscriptions, log };
}

/** 条件が成り立つまで、通知のたびに確かめ直す。通知は handler / statusFetcher の呼び出しで起きる */
function createSignal() {
  const waiters: (() => void)[] = [];
  return {
    notify() {
      for (const waiter of waiters.splice(0)) waiter();
    },
    async until(predicate: () => boolean) {
      while (!predicate()) await new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}

/** 呼び出しを捕まえ、結果を返す時点をテストが握る statusFetcher */
function createControlledFetcher() {
  const calls: { dir: string; resolve: (status: StatusFull) => void }[] = [];
  const signal = createSignal();
  const fetcher = (dir: string) =>
    new Promise<StatusFull>((resolve) => {
      calls.push({ dir, resolve });
      signal.notify();
    });
  async function nthCall(n: number) {
    await signal.until(() => calls.length >= n);
    return calls[n - 1];
  }
  return { fetcher, nthCall };
}

function cleanStatus(): StatusFull {
  return {
    statuses: {},
    renameOldPaths: {},
    head: "head",
    branchHead: "main",
    hasUpstream: false,
    ahead: 0,
    behind: 0,
    latestMtime: 0,
  };
}

function noopHandlers(): FsWatchHandlers {
  return {
    onFsChange: () => {},
    onGitStatusChange: () => {},
    onBranchChange: () => {},
    onRemoteRefsChange: () => {},
    onWorktreeChange: () => {},
  };
}

/** working tree のファイル変更を 1 件流し、status の取得を予約させる */
function touchWorkingTree(subscription: FakeSubscription): void {
  subscription.onEvents([join(subscription.root, "touched.txt")]);
}

const tempDirs: string[] = [];

// watch は git dir の解決で git を起動する
beforeAll(resolveGitBeforeTests);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gozd-fswatch-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeTempRepo(): string {
  const dir = makeTempDir();
  runFixtureGit(["init", "-b", "main"], dir);
  runFixtureGit(["config", "user.email", "test@example.com"], dir);
  runFixtureGit(["config", "user.name", "test"], dir);
  writeFileSync(join(dir, "init.txt"), "init\n");
  runFixtureGit(["add", "."], dir);
  runFixtureGit(["commit", "-m", "init"], dir);
  return dir;
}

// renderer を作り直すと、新しい renderer は既存の entry に watch を重ねるだけで status を持たない。
// 直近と同じ内容を送らないと、変化の無い worktree のバッジが黙って欠ける
test("再 watch 後は、直近の push と同じ内容の status も届け直す", async () => {
  const dir = makeTempRepo();
  const { transport, subscriptions } = createFakeTransport();
  const { fetcher, nthCall } = createControlledFetcher();
  const pushed = createSignal();
  let pushes = 0;
  const registry = createFsWatchRegistry(
    {
      ...noopHandlers(),
      onGitStatusChange: () => {
        pushes++;
        pushed.notify();
      },
    },
    // 判定は取得の呼び出しを同期点にしており debounce の長さに依存しない。0 は実時間の待ちを消すだけ
    { transport, statusFetcher: fetcher, statusDebounceMs: 0 },
  );
  await registry.watch(dir);
  const [subscription] = subscriptions;

  touchWorkingTree(subscription);
  (await nthCall(1)).resolve(cleanStatus());
  await pushed.until(() => pushes === 1);

  await registry.watch(dir);
  touchWorkingTree(subscription);
  (await nthCall(2)).resolve(cleanStatus());
  touchWorkingTree(subscription);
  await nthCall(3);
  await registry.unwatchAll();

  expect(pushes).toBe(2);
});

// packed-refs の変化は local と remote のどちらの ref か分からず、両方の候補が立つ。remotes が
// 動いていないのに remoteRefsChange を撃つと、renderer の PR 取得が GitHub の rate limit を黙って食う
test("remotes が動いていない packed-refs の変化では remoteRefsChange を撃たない", async () => {
  const dir = makeTempRepo();
  const { transport, subscriptions } = createFakeTransport();
  const branchChanged = createSignal();
  let branchChanges = 0;
  let remoteRefsChanges = 0;
  const registry = createFsWatchRegistry(
    {
      ...noopHandlers(),
      onBranchChange: () => {
        branchChanges++;
        branchChanged.notify();
      },
      onRemoteRefsChange: () => remoteRefsChanges++,
    },
    { transport, statusFetcher: async () => cleanStatus() },
  );
  await registry.watch(dir);
  const [subscription] = subscriptions;
  const packedRefs = join(realpathSync.native(dir), ".git", "packed-refs");

  // 初回は比較の基準が無いので両方撃つ
  subscription.onEvents([packedRefs]);
  await branchChanged.until(() => branchChanges === 1);
  expect(remoteRefsChanges).toBe(1);

  writeFileSync(join(dir, "second.txt"), "second\n");
  runFixtureGit(["add", "."], dir);
  runFixtureGit(["commit", "-m", "second"], dir);
  // branchChange と remoteRefsChange は同じ digest の比較から同期に撃たれる
  subscription.onEvents([packedRefs]);
  await branchChanged.until(() => branchChanges === 2);
  await registry.unwatchAll();

  expect(remoteRefsChanges).toBe(1);
});

/** repo と、その中の `.claude/worktrees/agent` に置いた worktree を作る */
function makeRepoWithNestedWorktree(): { repo: string; nested: string } {
  const repo = makeTempRepo();
  const nested = join(repo, ".claude", "worktrees", "agent");
  runFixtureGit(["worktree", "add", "-b", "agent", nested], repo);
  return { repo, nested };
}

function activeSubscriptions(subscriptions: FakeSubscription[]) {
  return subscriptions
    .filter((subscription) => !subscription.unsubscribed)
    .map(({ root, ignore }) => ({ root, ignore }));
}

// git dir に除外設定を掛けると、ref / HEAD の event が黙って落ちて branch と status の検知が止まる
test("除外設定は working tree の root にだけ掛け、git dir の root には掛けない", async () => {
  const { repo, nested } = makeRepoWithNestedWorktree();
  const { transport, subscriptions } = createFakeTransport();
  const registry = createFsWatchRegistry(noopHandlers(), {
    transport,
    statusFetcher: async () => cleanStatus(),
    getWatcherExclude: () => ["build/**"],
  });

  await registry.watch(nested);
  const active = activeSubscriptions(subscriptions);
  await registry.unwatchAll();

  expect(active).toEqual([
    { root: realpathSync.native(nested), ignore: ["build/**"] },
    { root: join(realpathSync.native(repo), ".git"), ignore: [] },
  ]);
});

// root を含む購読が含まれる root を ignore しないと、同じ event が二重に配送される。含まれる側の
// 除外設定は、含まれる側の root からの相対で当たり続ける
test("root が別の root を含むとき、含む側の購読は含まれる root を ignore する", async () => {
  const { repo, nested } = makeRepoWithNestedWorktree();
  const { transport, subscriptions } = createFakeTransport();
  const registry = createFsWatchRegistry(noopHandlers(), {
    transport,
    statusFetcher: async () => cleanStatus(),
    getWatcherExclude: () => ["build/**"],
  });

  await registry.watch(nested);
  await registry.watch(repo);
  const active = activeSubscriptions(subscriptions);
  await registry.unwatchAll();

  const repoRoot = realpathSync.native(repo);
  const nestedRoot = realpathSync.native(nested);
  const gitDir = join(repoRoot, ".git");
  expect(active).toEqual([
    { root: nestedRoot, ignore: ["build/**"] },
    { root: gitDir, ignore: [] },
    { root: repoRoot, ignore: ["build/**", nestedRoot, gitDir] },
  ]);
});

// 含まれる root の event は、その root を含む entry（外側のファイラー）と含まれる entry の両方に要る
test("1 本の購読に届いた event を、path を含む entry それぞれに配送する", async () => {
  const { repo, nested } = makeRepoWithNestedWorktree();
  const { transport, subscriptions } = createFakeTransport();
  const fsChanges: { dir: string; relDir: string }[] = [];
  const registry = createFsWatchRegistry(
    { ...noopHandlers(), onFsChange: (dir, relDir) => fsChanges.push({ dir, relDir }) },
    { transport, statusFetcher: async () => cleanStatus() },
  );

  await registry.watch(repo);
  await registry.watch(nested);
  const nestedRoot = realpathSync.native(nested);
  subscriptions
    .find((subscription) => !subscription.unsubscribed && subscription.root === nestedRoot)
    ?.onEvents([join(nestedRoot, "agent.txt")]);
  await registry.unwatchAll();

  expect(fsChanges).toEqual([
    { dir: repo, relDir: join(".claude", "worktrees", "agent") },
    { dir: nested, relDir: "" },
  ]);
});

// ignore の変わった購読を外してから張ると、張り替えの間に起きた変更を取りこぼす
test("含まれる root の出入りで含む側を張り替えるとき、新しい購読を張ってから古い購読を外す", async () => {
  const { repo, nested } = makeRepoWithNestedWorktree();
  const { transport, log } = createFakeTransport();
  const registry = createFsWatchRegistry(noopHandlers(), {
    transport,
    statusFetcher: async () => cleanStatus(),
  });

  await registry.watch(repo);
  await registry.watch(nested);
  await registry.unwatch(nested);
  const history = [...log];
  await registry.unwatchAll();

  const repoRoot = realpathSync.native(repo);
  const nestedRoot = realpathSync.native(nested);
  const gitDir = join(repoRoot, ".git");
  expect(history).toEqual([
    `+${repoRoot}`,
    // 入れ子を watch: 入れ子の root を張り終えてから、それを ignore する外側の新しい購読を張り、
    // 外側の古い購読を外す。どの時点でも入れ子の中はいずれかの購読に覆われている
    `+${nestedRoot}`,
    `+${gitDir}`,
    `+${repoRoot}`,
    `-${repoRoot}`,
    // 入れ子を unwatch: 外側を ignore の無い購読に張り替えてから、入れ子の root と、入れ子を
    // ignore していた外側の購読を外す
    `+${repoRoot}`,
    `-${nestedRoot}`,
    `-${gitDir}`,
    `-${repoRoot}`,
  ]);
});

// 張れなかった root を含む側が ignore すると、その root の中の変更がどの購読にも届かなくなる
test("含まれる root を張れなかったとき、含む側の購読はその root を ignore しない", async () => {
  const { repo, nested } = makeRepoWithNestedWorktree();
  const nestedRoot = realpathSync.native(nested);
  const { transport, subscriptions } = createFakeTransport((root) => root === nestedRoot);
  const registry = createFsWatchRegistry(noopHandlers(), {
    transport,
    statusFetcher: async () => cleanStatus(),
    logEvent: () => {},
  });

  await registry.watch(repo);
  const watched = await tryCatch(registry.watch(nested));
  await registry.unwatchAll();

  expect(watched.ok).toBe(false);
  // 失敗した entry を外すまでの間も含め、含む側に張ったどの購読も入れ子の root を ignore しない
  const repoRoot = realpathSync.native(repo);
  const ignoresNested = subscriptions
    .filter((subscription) => subscription.root === repoRoot)
    .map((subscription) => subscription.ignore.includes(nestedRoot));
  expect(ignoresNested).not.toHaveLength(0);
  expect(ignoresNested).not.toContain(true);
});

// 含む側の張り替えに失敗して古い購読が残ると、それが ignore する root の中を運べるのは
// その root の購読だけになる
test("含む側を張り替えられなかったとき、古い購読が ignore する root の購読を外さない", async () => {
  const { repo, nested } = makeRepoWithNestedWorktree();
  const repoRoot = realpathSync.native(repo);
  const nestedRoot = realpathSync.native(nested);
  let failRepo = false;
  const { transport, subscriptions } = createFakeTransport((root) => failRepo && root === repoRoot);
  const registry = createFsWatchRegistry(noopHandlers(), {
    transport,
    statusFetcher: async () => cleanStatus(),
    logEvent: () => {},
  });

  await registry.watch(repo);
  await registry.watch(nested);
  failRepo = true;
  await registry.unwatch(nested);
  const active = activeSubscriptions(subscriptions);
  failRepo = false;
  await registry.unwatchAll();

  expect(active).toEqual([
    { root: nestedRoot, ignore: [] },
    { root: join(repoRoot, ".git"), ignore: [] },
    { root: repoRoot, ignore: [nestedRoot, join(repoRoot, ".git")] },
  ]);
});

// 含む側の entry を外しても、含まれる側は自分の購読で監視を続ける
test("含む側の entry を unwatch しても、含まれる entry の購読は張り替えない", async () => {
  const { repo, nested } = makeRepoWithNestedWorktree();
  const { transport, subscriptions, log } = createFakeTransport();
  const fsChangeDirs: string[] = [];
  const registry = createFsWatchRegistry(
    { ...noopHandlers(), onFsChange: (dir) => fsChangeDirs.push(dir) },
    { transport, statusFetcher: async () => cleanStatus() },
  );

  await registry.watch(repo);
  await registry.watch(nested);
  const before = log.length;
  await registry.unwatch(repo);
  const repoRoot = realpathSync.native(repo);
  const nestedRoot = realpathSync.native(nested);
  expect(log.slice(before)).toEqual([`-${repoRoot}`]);

  subscriptions
    .find((subscription) => !subscription.unsubscribed && subscription.root === nestedRoot)
    ?.onEvents([join(nestedRoot, "agent.txt")]);
  await registry.unwatchAll();

  expect(fsChangeDirs).toEqual([nested]);
});

// 張れなかった entry を登録したままにすると、監視していない dir を監視済みとして扱い続ける
test("自分の root を張れなかった watch は失敗し、entry を登録しない", async () => {
  const dir = makeTempDir();
  const root = realpathSync.native(dir);
  const { transport } = createFakeTransport((subscribedRoot) => subscribedRoot === root);
  const events: string[] = [];
  const registry = createFsWatchRegistry(noopHandlers(), {
    transport,
    logEvent: (_channel, label, detail) => events.push(`${label} ${detail}`),
  });

  const watched = await tryCatch(registry.watch(dir));

  expect(watched.ok ? undefined : watched.error.message).toBe(`subscribe failed: ${root}`);
  expect(await registry.unwatchAll()).toBe(0);
  expect(events).toEqual([`subscribe-failed ${root}: Error: subscribe failed: ${root}`]);
});

// 張り直しの失敗を無関係な watch の失敗にすると、失敗の原因と通知される dir がずれる
test("別の entry の root を張り直せなくても、無関係な watch は成功し、張り直せなかった root の古い購読は残る", async () => {
  const [a, b] = [makeTempDir(), makeTempDir()];
  const rootA = realpathSync.native(a);
  let excludes = ["x/**"];
  // a の root は、除外設定が変わった後の張り直しだけ失敗させる
  const { transport, subscriptions } = createFakeTransport(
    (root, ignore) => root === rootA && ignore[0] === "y/**",
  );
  const events: string[] = [];
  const registry = createFsWatchRegistry(noopHandlers(), {
    transport,
    getWatcherExclude: () => excludes,
    logEvent: (_channel, label, detail) => events.push(`${label} ${detail}`),
  });

  await registry.watch(a);
  excludes = ["y/**"];
  await registry.watch(b);
  const active = activeSubscriptions(subscriptions);
  await registry.unwatchAll();

  expect(active).toEqual([
    { root: rootA, ignore: ["x/**"] },
    { root: realpathSync.native(b), ignore: ["y/**"] },
  ]);
  expect(events).toEqual([`subscribe-failed ${rootA}: Error: subscribe failed: ${rootA}`]);
});

// 片方の unwatch で解放すると、残った購読者のファイラーと git status が黙って止まる
test("同じ dir の watch は購読を共有し、最後の unwatch でだけ解放する", async () => {
  // git 管理外の dir は status 取得を予約しないので、解放後に取得が残らない
  const dir = makeTempDir();
  const { transport, subscriptions } = createFakeTransport();
  const registry = createFsWatchRegistry(noopHandlers(), { transport });

  await registry.watch(dir);
  await registry.watch(dir);
  expect(subscriptions).toHaveLength(1);

  await registry.unwatch(dir);
  expect(subscriptions[0].unsubscribed).toBe(false);

  await registry.unwatch(dir);
  expect(subscriptions[0].unsubscribed).toBe(true);
});

// renderer の unmount で呼ばれる。解放が漏れると native 監視が黙って残り、再構築のたびに積み上がる
test("unwatchAll は全 entry の購読を解放して件数を返し、以降のイベントを配送しない", async () => {
  // git 管理外の dir は status 取得を予約しないので、解放後に取得が残らない
  const dirs = [makeTempDir(), makeTempDir()];
  const { transport, subscriptions } = createFakeTransport();
  const fsChangeDirs: string[] = [];
  const registry = createFsWatchRegistry(
    { ...noopHandlers(), onFsChange: (dir) => fsChangeDirs.push(dir) },
    { transport },
  );

  for (const dir of dirs) await registry.watch(dir);
  // 解放前は同じ経路でイベントが配送される。以下の「配送しない」が空振りでないことの対照
  for (const subscription of subscriptions) {
    subscription.onEvents([join(subscription.root, "before.txt")]);
  }
  expect(fsChangeDirs).toEqual(dirs);
  fsChangeDirs.length = 0;

  expect(await registry.unwatchAll()).toBe(dirs.length);

  expect(subscriptions.map((subscription) => subscription.unsubscribed)).toEqual([true, true]);
  // native 側の解放は非同期なので、解放前に積まれていたイベントも捨てられる必要がある
  for (const subscription of subscriptions) {
    subscription.onEvents([join(subscription.root, "after.txt")]);
  }
  expect(fsChangeDirs).toEqual([]);
});
