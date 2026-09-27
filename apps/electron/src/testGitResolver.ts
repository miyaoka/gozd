// テスト対象の実装が起動する git の絶対パスを、テストの前に解決しておくヘルパー。
// preload（testPreload.ts）が import する testGitFixture.ts から分けて置くのは、preload の
// import の連鎖に本番のモジュールを入れないため。入れると、preload が GIT_* を消す前に
// それらが評価される。

import { spyOn } from "bun:test";
import { tryCatch } from "@gozd/shared";
import { commandResolver } from "./commandResolver";

/**
 * 実装は初回の解決で観察ログを stderr に出すが、それは git を起動するテストの検証対象ではない。
 * beforeAll で呼び、以降のテストで出る出力は吸わずに見えるままにする
 */
export async function resolveGitBeforeTests(): Promise<void> {
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  const resolved = await tryCatch(commandResolver.resolve("git"));
  consoleError.mockRestore();
  if (!resolved.ok) throw resolved.error;
}
