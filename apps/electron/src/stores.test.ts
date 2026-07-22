import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RawJsonTypeError } from "./rawJson";
import { loadAppConfigFrom, loadAppStateFrom, normalizeAppConfig, normalizeAppState } from "./stores";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "gozd-stores-test-"));
}

describe("normalizeAppState (strict)", () => {
  test("欠落フィールドは default 充填する（proto3 契約の維持）", () => {
    const state = normalizeAppState({
      sidebarRepos: [{ rootDir: "/r1" }],
      repoLists: [{ id: "p1" }],
    });
    expect(state.sidebarRepos[0]).toEqual({
      rootDir: "/r1",
      repoName: "",
      isGitRepo: false,
      collapsed: false,
      worktrees: [],
    });
    expect(state.repoLists[0]).toEqual({ id: "p1", name: "", dirOrder: [] });
    expect(state.activeRepoListId).toBe("");
    expect(state.activeDir).toBeUndefined();
  });

  test("存在するが型違反のフィールドは RawJsonTypeError（破損扱い）", () => {
    expect(() => normalizeAppState({ repoLists: [{ id: 1 }] })).toThrow(RawJsonTypeError);
    expect(() => normalizeAppState({ repoLists: [{ name: null }] })).toThrow(RawJsonTypeError);
    expect(() => normalizeAppState({ repoLists: [{ dirOrder: ["/a", 2] }] })).toThrow(
      RawJsonTypeError,
    );
    expect(() => normalizeAppState({ sidebarRepos: [{ collapsed: "yes" }] })).toThrow(
      RawJsonTypeError,
    );
    expect(() =>
      normalizeAppState({ sidebarRepos: [{ worktrees: [{ isMain: 1 }] }] }),
    ).toThrow(RawJsonTypeError);
    expect(() => normalizeAppState({ activeRepoListId: 5 })).toThrow(RawJsonTypeError);
    expect(() => normalizeAppState({ activeDir: 5 })).toThrow(RawJsonTypeError);
  });

  test("activeDir の空文字は unset（キー不在）に正規化する", () => {
    expect(normalizeAppState({ activeDir: "" }).activeDir).toBeUndefined();
    expect(normalizeAppState({ activeDir: "/wt" }).activeDir).toBe("/wt");
  });
});

describe("loadAppStateFrom (reinit)", () => {
  test("型違反ファイルは初期状態で上書き save し、初期状態を返す", () => {
    const path = join(makeTempDir(), "app-state.json");
    writeFileSync(path, JSON.stringify({ repoLists: [{ id: 1, name: "x" }], keep: "me" }));

    const state = loadAppStateFrom(path);
    expect(state.repoLists).toEqual([]);
    expect(state.sidebarRepos).toEqual([]);

    // ファイルが初期状態で上書きされている（起動のたびに失敗し続けない）
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written.repoLists).toEqual([]);
    // 破損ファイル由来の未知キーも保持される（saveAppState の shallow merge 契約）
    expect(written.keep).toBe("me");
  });

  test("parse 不能ファイルも同じ reinit 経路に倒れる", () => {
    const path = join(makeTempDir(), "app-state.json");
    writeFileSync(path, "{ broken");

    const state = loadAppStateFrom(path);
    expect(state.sidebarRepos).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ sidebarRepos: [] });
  });

  test("正常ファイルはそのまま読める", () => {
    const path = join(makeTempDir(), "app-state.json");
    writeFileSync(
      path,
      JSON.stringify({
        sidebarRepos: [
          {
            rootDir: "/r1",
            repoName: "r1",
            isGitRepo: true,
            collapsed: false,
            worktrees: [{ path: "/r1", branch: "main", isMain: true }],
          },
        ],
        repoLists: [{ id: "p1", name: "Default", dirOrder: ["/r1"] }],
        activeRepoListId: "p1",
        activeDir: "/r1",
      }),
    );
    const state = loadAppStateFrom(path);
    expect(state.repoLists[0]?.dirOrder).toEqual(["/r1"]);
    expect(state.activeDir).toBe("/r1");
  });
});

describe("normalizeAppConfig (lenient)", () => {
  test("型違反フィールドは default に倒す（throw しない）", () => {
    const config = normalizeAppConfig({
      terminal: { theme: 5, fontSize: "12" },
      voicevox: { enabled: "yes", speakerId: "3" },
      arcade: { sfxEnabled: 1 },
    });
    expect(config.terminal.theme).toBe("");
    expect(config.terminal.fontSize).toBe(0);
    expect(config.voicevox.enabled).toBe(false);
    // optional は「未設定 = キー不在」へ倒す
    expect(config.voicevox.speakerId).toBeUndefined();
    expect(config.arcade.sfxEnabled).toBeUndefined();
  });

  test("セクション自体の型違反も default セクションに倒す", () => {
    const config = normalizeAppConfig({ terminal: "dark" });
    expect(config.terminal).toEqual({ theme: "", fontFamily: "", fontSize: 0 });
  });

  test("watcherExclude は boolean 以外の値だけ落とす", () => {
    const config = normalizeAppConfig({ watcherExclude: { "a/**": true, "b/**": "yes" } });
    expect(config.watcherExclude).toEqual({ "a/**": true });
  });
});

describe("loadAppConfigFrom (ユーザー設定はファイル不変)", () => {
  test("parse 不能ファイルは default で返し、ファイルは書き換えない", () => {
    const path = join(makeTempDir(), "config.json");
    writeFileSync(path, "{ broken");

    const config = loadAppConfigFrom(path);
    expect(config.terminal.theme).toBe("");
    // reinit しない: 壊れた原文が残る（修復はユーザーの責務）
    expect(readFileSync(path, "utf8")).toBe("{ broken");
  });

  test("型違反フィールドがあってもファイルは書き換えない", () => {
    const path = join(makeTempDir(), "config.json");
    const original = JSON.stringify({ terminal: { fontSize: "12" } });
    writeFileSync(path, original);

    const config = loadAppConfigFrom(path);
    expect(config.terminal.fontSize).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("ファイル不在は default（ファイルを作らない）", () => {
    const path = join(makeTempDir(), "config.json");
    const config = loadAppConfigFrom(path);
    expect(config.watcherExclude).toEqual({
      ".git/objects/**": true,
      ".git/subtree-cache/**": true,
    });
    expect(existsSync(path)).toBe(false);
  });
});
