// commandResolver のテスト。
//
// resolver は name をログインシェルに渡す script 文字列へ補間するため、name の検証が shell 注入の
// 境界になる。境界が崩れても解決は成功しうるので利用者からは見えない。ここではその境界だけを検証する。

import { tryCatch } from "@gozd/shared";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandResolver } from "./commandResolver";

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
