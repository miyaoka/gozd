// absFileWatcher の統合テスト。refcount 共有 / 対象 stat 変化による判定 / debounce 集約 /
// unwatch での watcher 破棄 / 非絶対パス reject の契約を固定する。
// fs.watch (FSEvents) の event 到達は非同期のため、poll で待つ。
// イベントの filename はランタイム依存で当てにならない (atomic write の rename が tmp 名で
// 届く / 無関係ファイルで対象名の spurious イベントが届く) ため、判定は stat 比較が SSOT。

import { tryCatch } from "@gozd/shared";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwatchAbsFile, unwatchAllAbsFiles, watchAbsFile } from "./absFileWatcher";

const WAIT_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 25;
/** 「イベントがもう来ない」ことの確認待ち。debounce (100ms) より十分長く取る */
const SETTLE_MS = 400;

async function waitFor(predicate: () => boolean): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < WAIT_TIMEOUT_MS) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return predicate();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("absFileWatcher", () => {
  const tempDirs: string[] = [];
  const pushes: { type: string; payload: unknown }[] = [];
  const push = (type: string, payload: unknown) => pushes.push({ type, payload });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-absfilewatcher-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function pushCountFor(path: string): number {
    return pushes.filter(
      (p) => p.type === "fsChangeAbsolute" && (p.payload as { path: string }).path === path,
    ).length;
  }

  afterEach(() => {
    unwatchAllAbsFiles();
    pushes.splice(0);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("watch 中ファイルの変更で fsChangeAbsolute が push される", async () => {
    const dir = makeTempDir();
    const path = join(dir, "config.json");
    writeFileSync(path, "{}");
    watchAbsFile(path, push);
    writeFileSync(path, '{"a":1}');
    expect(await waitFor(() => pushCountFor(path) >= 1)).toBe(true);
  });

  test("atomic write (tmp + rename) でも対象 path として検知される", async () => {
    const dir = makeTempDir();
    const path = join(dir, "config.json");
    writeFileSync(path, "{}");
    watchAbsFile(path, push);
    const tmpPath = `${path}.tmp-test`;
    writeFileSync(tmpPath, '{"a":1}');
    renameSync(tmpPath, path);
    expect(await waitFor(() => pushCountFor(path) >= 1)).toBe(true);
  });

  test("同 dir の別ファイルの変更では push されない (対象 stat 不変)", async () => {
    const dir = makeTempDir();
    const path = join(dir, "config.json");
    writeFileSync(path, "{}");
    watchAbsFile(path, push);
    writeFileSync(join(dir, "other.json"), "{}");
    await sleep(SETTLE_MS);
    expect(pushCountFor(path)).toBe(0);
  });

  test("refcount: 二重 watch は片方 unwatch しても生き、全 unwatch で止まる", async () => {
    const dir = makeTempDir();
    const path = join(dir, "config.json");
    writeFileSync(path, "{}");
    watchAbsFile(path, push);
    watchAbsFile(path, push);

    unwatchAbsFile(path);
    writeFileSync(path, '{"a":1}');
    expect(await waitFor(() => pushCountFor(path) >= 1)).toBe(true);

    unwatchAbsFile(path);
    const countAfterFullUnwatch = pushCountFor(path);
    writeFileSync(path, '{"a":2}');
    await sleep(SETTLE_MS);
    expect(pushCountFor(path)).toBe(countAfterFullUnwatch);
  });

  test("watch していない path の unwatch は no-op", () => {
    const dir = makeTempDir();
    expect(tryCatch(() => unwatchAbsFile(join(dir, "never-watched.json"))).ok).toBe(true);
  });

  test("非絶対パスは reject される", () => {
    const result = tryCatch(() => watchAbsFile("relative/config.json", push));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String(result.error)).toContain("notAbsolutePath");
  });

  test("親 dir 不在の watch はエラーになる", () => {
    const dir = makeTempDir();
    const result = tryCatch(() => watchAbsFile(join(dir, "missing", "config.json"), push));
    expect(result.ok).toBe(false);
  });
});
