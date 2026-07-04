// windowState store のテスト。Swift 側に対応物は無い（macOS 標準復元任せのため）。
// 契約: round-trip 保存、壊れた永続ファイルはデフォルト起動（undefined）に倒れて
// throw しない（後方互換を作らない永続データポリシー）。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowStateStore } from "./windowState";

describe("windowStateStore", () => {
  const dirs: string[] = [];

  function makeStateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-window-state-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("save した bounds を load で round-trip できる", () => {
    const store = createWindowStateStore(makeStateDir());
    const bounds = { x: 100, y: 50, width: 1440, height: 900 };
    store.saveBounds(bounds);
    expect(store.loadBounds()).toEqual(bounds);
  });

  test("ファイル不在なら undefined（初回起動はデフォルトサイズ）", () => {
    const store = createWindowStateStore(makeStateDir());
    expect(store.loadBounds()).toBeUndefined();
  });

  test("JSON parse 失敗は throw せず undefined に倒れる", () => {
    const dir = makeStateDir();
    writeFileSync(join(dir, "electron-window.json"), "{ broken");
    const store = createWindowStateStore(dir);
    expect(store.loadBounds()).toBeUndefined();
  });

  test("bounds の形が壊れていたら undefined（数値でない / 非正サイズ）", () => {
    const dir = makeStateDir();
    const path = join(dir, "electron-window.json");
    const store = createWindowStateStore(dir);

    writeFileSync(path, JSON.stringify({ bounds: { x: "0", y: 0, width: 100, height: 100 } }));
    expect(store.loadBounds()).toBeUndefined();

    writeFileSync(path, JSON.stringify({ bounds: { x: 0, y: 0, width: 0, height: 100 } }));
    expect(store.loadBounds()).toBeUndefined();

    writeFileSync(path, JSON.stringify({ bounds: null }));
    expect(store.loadBounds()).toBeUndefined();

    writeFileSync(path, JSON.stringify({}));
    expect(store.loadBounds()).toBeUndefined();
  });

  test("save は既存ファイルを丸ごと置き換える（bounds 以外の未知キーは保持しない）", () => {
    const dir = makeStateDir();
    const path = join(dir, "electron-window.json");
    writeFileSync(path, JSON.stringify({ bounds: { x: 0, y: 0, width: 1, height: 1 }, junk: true }));
    const store = createWindowStateStore(dir);
    store.saveBounds({ x: 10, y: 20, width: 800, height: 600 });
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written.junk).toBeUndefined();
    expect(written.bounds).toEqual({ x: 10, y: 20, width: 800, height: 600 });
  });
});
