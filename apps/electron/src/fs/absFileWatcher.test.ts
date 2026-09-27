// absFileWatcher の refcount 契約を固定する。同じ path の watch 要求（本体 preview と pinned
// window 等）は 1 つの watcher を共有し、最後の unwatch でだけ watcher を閉じる。
// 途中の unwatch で閉じると残りの要求元が無言で追従を失い、閉じ忘れると watcher が漏れる。
//
// node:fs の watch を spy して watcher の生成と close の回数を数える。fs イベントの到達は
// 検証しない（到達を待つ判定は時間の上限でしか落とせない）。

import type { PushFn } from "../rpcDispatcher";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwatchAbsFile, unwatchAllAbsFiles, watchAbsFile } from "./absFileWatcher";

describe("absFileWatcher", () => {
  const tempDirs: string[] = [];
  const push: PushFn = () => {};

  afterEach(() => {
    unwatchAllAbsFiles();
    mock.restore();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refcount: 同 path の watch は watcher を共有し、最後の unwatch でだけ閉じる", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "gozd-absfilewatcher-test-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");

    const realWatch = fs.watch;
    const closeSpies: ReturnType<typeof spyOn>[] = [];
    const watchSpy = spyOn(fs, "watch").mockImplementation(((
      ...args: Parameters<typeof fs.watch>
    ) => {
      const watcher = realWatch(...args);
      closeSpies.push(spyOn(watcher, "close"));
      return watcher;
    }) as typeof fs.watch);

    watchAbsFile(path, push);
    watchAbsFile(path, push);
    expect(watchSpy).toHaveBeenCalledTimes(1);
    const [closeSpy] = closeSpies;

    unwatchAbsFile(path);
    expect(closeSpy).toHaveBeenCalledTimes(0);

    unwatchAbsFile(path);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
