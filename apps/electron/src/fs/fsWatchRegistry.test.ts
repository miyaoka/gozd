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
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusFull } from "../git/porcelain";
import { resolveGitBeforeTests, runFixtureGit } from "../testGitFixture";
import {
  createFsWatchRegistry,
  type FsWatchHandlers,
  type WatchTransport,
} from "./fsWatchRegistry";

interface FakeSubscription {
  root: string;
  onEvents: (paths: string[]) => void;
  unsubscribed: boolean;
}

function createFakeTransport() {
  const subscriptions: FakeSubscription[] = [];
  const transport: WatchTransport = {
    async subscribe(root, _ignore, onEvents) {
      const subscription: FakeSubscription = { root, onEvents, unsubscribed: false };
      subscriptions.push(subscription);
      return {
        async unsubscribe() {
          subscription.unsubscribed = true;
        },
      };
    },
  };
  return { transport, subscriptions };
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
  registry.unwatchAll();

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
  registry.unwatchAll();

  expect(remoteRefsChanges).toBe(1);
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

  registry.unwatch(dir);
  expect(subscriptions[0].unsubscribed).toBe(false);

  registry.unwatch(dir);
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

  expect(registry.unwatchAll()).toBe(dirs.length);

  expect(subscriptions.map((subscription) => subscription.unsubscribed)).toEqual([true, true]);
  // native 側の解放は非同期なので、解放前に積まれていたイベントも捨てられる必要がある
  for (const subscription of subscriptions) {
    subscription.onEvents([join(subscription.root, "after.txt")]);
  }
  expect(fsChangeDirs).toEqual([]);
});
