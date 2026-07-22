// FSWatchRegistry の統合テスト。実 git repo + 実 @parcel/watcher で event → classify →
// digest gating → dispatch の経路を検証する。Swift 版 `FSWatchRegistryTests.swift` の
// 統合テスト部（dispatchesFsChangeOnWorkTreeFile / classifiesBranchChange 等）の対応物。
//
// macOS の TMPDIR は `/var/folders/...`（実体 `/private/var/...`）の symlink 配下なので、
// このテストは realpath 解決（watch キーと event path の整合）も自然に踏む。

import { subscribe as parcelSubscribe } from "@parcel/watcher";
import { afterEach, describe, expect, test } from "bun:test";
import { runFixtureGit } from "../testGitFixture";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsWatchRegistry, type WatchTransport } from "./fsWatchRegistry";

// production は utilityProcess 隔離した watcherClient を注入するが、統合テストでは
// 実 @parcel/watcher を in-process で直接包む transport を注入し、classify 経路を検証する
const realParcelTransport: WatchTransport = {
  async subscribe(root, ignore, onEvents, onError) {
    const sub = await parcelSubscribe(
      root,
      (err, events) => {
        if (err !== null) {
          onError(String(err));
          return;
        }
        onEvents(events.map((event) => event.path));
      },
      ignore.length > 0 ? { ignore } : undefined,
    );
    return { unsubscribe: () => sub.unsubscribe() };
  },
};

const WAIT_TIMEOUT_MS = 5000;
const WAIT_INTERVAL_MS = 25;
/** テストでは debounce 窓を縮めて全体を速くする（production は 150ms） */
const TEST_STATUS_DEBOUNCE_MS = 50;

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
  }
  throw new Error(`waitUntil timeout: ${label}`);
}

function initGitRepo(dir: string): void {
  runFixtureGit(["init", "-b", "main"], dir);
  runFixtureGit(["config", "user.email", "test@example.com"], dir);
  runFixtureGit(["config", "user.name", "test"], dir);
  writeFileSync(join(dir, "init.txt"), "init\n");
  runFixtureGit(["add", "."], dir);
  runFixtureGit(["commit", "-m", "init"], dir);
}

interface Recorded {
  fsChanges: { dir: string; relDir: string }[];
  statusDirs: string[];
  branchDirs: string[];
  remoteDirs: string[];
  worktreeDirs: string[];
}

function createRecordingRegistry() {
  const recorded: Recorded = {
    fsChanges: [],
    statusDirs: [],
    branchDirs: [],
    remoteDirs: [],
    worktreeDirs: [],
  };
  const registry = createFsWatchRegistry(
    {
      onFsChange: (dir, relDir) => recorded.fsChanges.push({ dir, relDir }),
      onGitStatusChange: (dir) => recorded.statusDirs.push(dir),
      onBranchChange: (dir) => recorded.branchDirs.push(dir),
      onRemoteRefsChange: (dir) => recorded.remoteDirs.push(dir),
      onWorktreeChange: (dir) => recorded.worktreeDirs.push(dir),
    },
    { statusDebounceMs: TEST_STATUS_DEBOUNCE_MS, transport: realParcelTransport },
  );
  return { registry, recorded };
}

describe("FSWatchRegistry (integration)", () => {
  const tempDirs: string[] = [];
  const cleanups: (() => void)[] = [];

  function makeTempRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-fswatch-test-"));
    tempDirs.push(dir);
    initGitRepo(dir);
    return dir;
  }

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("watch した dir 配下のファイル作成で fsChange + gitStatusChange が届く", async () => {
    const dir = makeTempRepo();
    const { registry, recorded } = createRecordingRegistry();
    cleanups.push(() => registry.unwatchAll());

    await registry.watch(dir);
    writeFileSync(join(dir, "note.txt"), "hello\n");

    await waitUntil(() => recorded.fsChanges.length > 0, "fsChange");
    // push payload は watch 時の原文 dir を返す契約（realpath 解決値ではない）
    expect(recorded.fsChanges[0].dir).toBe(dir);
    expect(recorded.fsChanges[0].relDir).toBe("");
    await waitUntil(() => recorded.statusDirs.length > 0, "gitStatusChange");
    expect(recorded.statusDirs[0]).toBe(dir);
  });

  test("commit は branchChange を撃つが remoteRefsChange は撃たない（digest gating）", async () => {
    const dir = makeTempRepo();
    const { registry, recorded } = createRecordingRegistry();
    cleanups.push(() => registry.unwatchAll());

    await registry.watch(dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    runFixtureGit(["add", "."], dir);
    runFixtureGit(["commit", "-m", "second"], dir);

    // commit は refs/heads を動かす → branchChange 候補 → heads digest 変化で発火
    await waitUntil(() => recorded.branchDirs.length > 0, "branchChange");
    expect(recorded.branchDirs[0]).toBe(dir);
    // remotes digest は不変なので remoteRefsChange は発火しない（初回 baseline は
    // prev 不在の無条件発火だが、commit の classify は remote 候補自体を立てない）
    expect(recorded.remoteDirs).toEqual([]);
  });

  test("既存 branch への切替は head digest 経由で worktreeChange を撃つ", async () => {
    const dir = makeTempRepo();
    const { registry, recorded } = createRecordingRegistry();
    cleanups.push(() => registry.unwatchAll());

    runFixtureGit(["branch", "other"], dir);
    await registry.watch(dir);
    runFixtureGit(["switch", "other"], dir);

    // `.git/HEAD` の symbolic-ref 先変化 → head 候補 → digest の head 変化 → worktreeChange
    await waitUntil(() => recorded.worktreeDirs.length > 0, "worktreeChange");
    expect(recorded.worktreeDirs[0]).toBe(dir);
  });

  test("unwatchAll は全 entry を破棄して件数を返し、以降イベントが届かない", async () => {
    const dir = makeTempRepo();
    const { registry, recorded } = createRecordingRegistry();

    await registry.watch(dir);
    expect(registry.unwatchAll()).toBe(1);
    writeFileSync(join(dir, "after.txt"), "x\n");

    // 負の証明は時間で切る: debounce + 配送猶予を待って何も来ないことを確認する
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(recorded.fsChanges).toEqual([]);
    expect(recorded.statusDirs).toEqual([]);
  });

  test("同一 dir の再 watch は refCount を増やすだけで、片方の unwatch では監視が生き続ける", async () => {
    const dir = makeTempRepo();
    const { registry, recorded } = createRecordingRegistry();
    cleanups.push(() => registry.unwatchAll());

    await registry.watch(dir);
    await registry.watch(dir);
    registry.unwatch(dir);
    writeFileSync(join(dir, "still-watched.txt"), "x\n");

    await waitUntil(() => recorded.fsChanges.length > 0, "fsChange after partial unwatch");
    // 最後の購読者の unwatch で実解放される
    registry.unwatch(dir);
    expect(registry.unwatchAll()).toBe(0);
  });
});
