// commandResolver のテスト。検証するのは次の 2 つ。
//
// - shell 注入の境界: resolver は name をログインシェルに渡す script 文字列へ補間するため、name の
//   検証が境界になる。境界が崩れても解決は成功しうる
// - 起動の ENOENT の分類: cwd が無いのか、キャッシュした実行ファイルが無いのかを取り違えると、
//   ログインシェルでの解決を起動のたびに黙ってやり直すか、消えた実行ファイルを掴み続ける

import { tryCatch } from "@gozd/shared";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { commandResolver, createCommandResolver, withResolvedCommand } from "./commandResolver";
import { resolveGitBeforeTests } from "./testGitResolver";

const execFileAsync = promisify(execFile);

describe("createCommandResolver", () => {
  // shell には存在しないパスを渡し、境界が崩れても何も実行されないようにする。境界が崩れると
  // spawn 失敗の別メッセージで reject されるため、メッセージで境界の throw と区別する
  test.each(["git; true", "git$(true)", "", "あいう"])(
    "shell 注入になりうる name %p は shell に渡さず throw する",
    async (name) => {
      const resolver = createCommandResolver({
        shellOverride: join(tmpdir(), `gozd-no-such-shell-${randomUUID()}`),
      });
      const result = await tryCatch(resolver.resolve(name));
      expect(result.ok ? undefined : result.error.message).toMatch(/invalid command name/);
    },
  );
});

describe("withResolvedCommand", () => {
  beforeAll(resolveGitBeforeTests);

  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  function spyInvalidate() {
    const invalidate = spyOn(commandResolver, "invalidate");
    spies.push(invalidate);
    return invalidate;
  }

  test("cwd が無い起動の ENOENT は、解決をやり直さずに cwd を名指しする", async () => {
    const missing = join(tmpdir(), `gozd-no-such-cwd-${randomUUID()}`);
    const invalidate = spyInvalidate();
    let runs = 0;
    const result = await tryCatch(
      withResolvedCommand("git", missing, (gitPath) => {
        runs++;
        return execFileAsync(gitPath, ["--version"], { cwd: missing });
      }),
    );

    expect(result.ok ? undefined : result.error.message).toStartWith(
      `The cwd is invalid: ${missing}`,
    );
    expect(runs).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("cwd も実行ファイルも在るのに起きた ENOENT は、解決をやり直さずにそのまま投げる", async () => {
    const invalidate = spyInvalidate();
    const enoent = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    let runs = 0;
    const result = await tryCatch(
      withResolvedCommand("git", tmpdir(), async () => {
        runs++;
        throw enoent;
      }),
    );

    expect(result.ok ? undefined : result.error).toBe(enoent);
    expect(runs).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  // mise / asdf の upgrade で versioned path が消えると、キャッシュした実行ファイルが無くなる
  test("キャッシュした実行ファイルが無い起動の ENOENT は、解決をやり直して起動し直す", async () => {
    const stale = join(tmpdir(), `gozd-no-such-git-${randomUUID()}`);
    // beforeAll で解決済みなのでキャッシュから返る。ログインシェルは起動しない
    const resolvedGit = await commandResolver.resolve("git");
    if (resolvedGit === undefined) throw new Error("git is not resolved");
    // 1 回目は消えた実行ファイル、再解決では実在する git を返す。本物のキャッシュには触れない
    let resolves = 0;
    const resolve = spyOn(commandResolver, "resolve").mockImplementation(async () => {
      resolves++;
      return resolves === 1 ? stale : resolvedGit;
    });
    spies.push(resolve);
    const invalidate = spyInvalidate().mockImplementation(() => {});
    // 再解決の観察ログは検証対象ではないので吸う
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    spies.push(consoleError);
    const ran: string[] = [];
    const result = await tryCatch(
      withResolvedCommand("git", tmpdir(), async (gitPath) => {
        ran.push(gitPath);
        return execFileAsync(gitPath, ["--version"], { cwd: tmpdir() });
      }),
    );

    expect(result.ok).toBe(true);
    expect(ran).toEqual([stale, resolvedGit]);
    expect(resolves).toBe(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
