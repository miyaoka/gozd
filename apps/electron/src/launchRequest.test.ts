// consumeLaunchRequest のテスト。Swift 版 `AppRuntime.consumeLaunchRequest` と同じ契約:
// 最古 1 件のみ consume（残りは持ち越し）、読み取り成否に関わらず対象ファイルは削除。

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeLaunchRequest } from "./launchRequest";

describe("consumeLaunchRequest", () => {
  const dirs: string[] = [];

  function makeLaunchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-launch-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dir 不在（cold start 履歴なし）は undefined", () => {
    expect(consumeLaunchRequest("/nonexistent/gozd-launch")).toBeUndefined();
  });

  test("空 dir は undefined", () => {
    expect(consumeLaunchRequest(makeLaunchDir())).toBeUndefined();
  });

  test("request を 1 件読んで targetPath を返し、ファイルを削除する", () => {
    const dir = makeLaunchDir();
    const file = join(dir, "req.json");
    writeFileSync(file, JSON.stringify({ targetPath: "/Users/foo/repo" }));
    expect(consumeLaunchRequest(dir)).toBe("/Users/foo/repo");
    expect(existsSync(file)).toBe(false);
  });

  test("複数あれば最古の 1 件だけ consume し、残りは持ち越す", async () => {
    const dir = makeLaunchDir();
    const older = join(dir, "older.json");
    const newer = join(dir, "newer.json");
    writeFileSync(older, JSON.stringify({ targetPath: "/first" }));
    // birthtime の分解能差を跨ぐための待機
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(newer, JSON.stringify({ targetPath: "/second" }));

    expect(consumeLaunchRequest(dir)).toBe("/first");
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
    expect(consumeLaunchRequest(dir)).toBe("/second");
  });

  test("壊れた JSON は undefined だがファイルは削除される（残留 request の永久失敗を防ぐ）", () => {
    const dir = makeLaunchDir();
    const file = join(dir, "broken.json");
    writeFileSync(file, "{ broken");
    expect(consumeLaunchRequest(dir)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test("targetPath 欠落 / 空文字は undefined だがファイルは削除される", () => {
    const dir = makeLaunchDir();
    const missing = join(dir, "missing.json");
    writeFileSync(missing, JSON.stringify({ other: 1 }));
    expect(consumeLaunchRequest(dir)).toBeUndefined();
    expect(existsSync(missing)).toBe(false);

    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ targetPath: "" }));
    expect(consumeLaunchRequest(dir)).toBeUndefined();
    expect(existsSync(empty)).toBe(false);
  });
});
