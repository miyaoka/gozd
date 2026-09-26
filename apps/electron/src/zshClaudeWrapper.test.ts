// zsh init が注入する `claude` ラッパーのテスト。
// PATH 上の `claude` を引数を表示するだけのスタブに差し替え、ラッパーが付ける引数を観測する。
// ユーザーの初期化ファイルを読ませないよう、空の ZDOTDIR を渡す。

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ZSHRC = resolve(import.meta.dir, "../resources/zsh/.zshrc");
const ARGS_MARKER = "CLAUDE_ARGS:";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(): {
  root: string;
  concierge: string;
  other: string;
  bin: string;
  home: string;
} {
  const root = mkdtempSync(join(tmpdir(), "gozd-zsh-claude-"));
  tempDirs.push(root);
  const concierge = join(root, "concierge");
  const other = join(root, "other");
  const bin = join(root, "bin");
  const home = join(root, "home");
  for (const dir of [concierge, other, bin, home]) mkdirSync(dir);
  const stub = join(bin, "claude");
  writeFileSync(stub, `#!/bin/sh\nprintf '${ARGS_MARKER}%s\\n' "$*"\n`);
  chmodSync(stub, 0o755);
  return { root, concierge, other, bin, home };
}

/** cwd で `claude` を実行し、スタブが受け取った引数の行を返す */
function claudeArgs(cwd: string, fixture: ReturnType<typeof makeFixture>): string {
  const output = execFileSync(
    "zsh",
    ["-f", "-c", `source ${JSON.stringify(ZSHRC)}; cd ${JSON.stringify(cwd)}; claude hello`],
    {
      encoding: "utf8",
      env: {
        PATH: `${fixture.bin}:/usr/bin:/bin`,
        HOME: fixture.home,
        GOZD_USER_ZDOTDIR: fixture.home,
        GOZD_CLAUDE_SETTINGS_PATH: "/tmp/settings.json",
        GOZD_CONCIERGE_DIR: fixture.concierge,
        GOZD_CONCIERGE_PROMPT: "/tmp/concierge-prompt.md",
      },
    },
  );
  const line = output.split("\n").find((l) => l.includes(ARGS_MARKER));
  if (line === undefined) throw new Error(`stub claude was not called: ${output}`);
  return line.slice(line.indexOf(ARGS_MARKER) + ARGS_MARKER.length);
}

describe("zsh claude wrapper", () => {
  test("窓口のディレクトリで起動すると窓口の指示を付ける", () => {
    const fixture = makeFixture();
    expect(claudeArgs(fixture.concierge, fixture)).toBe(
      "--append-system-prompt-file /tmp/concierge-prompt.md --settings /tmp/settings.json hello",
    );
  });

  test("窓口以外のディレクトリでは付けない", () => {
    const fixture = makeFixture();
    expect(claudeArgs(fixture.other, fixture)).toBe("--settings /tmp/settings.json hello");
  });

  test("窓口の下のディレクトリでは付けない", () => {
    const fixture = makeFixture();
    const sub = join(fixture.concierge, "sub");
    mkdirSync(sub);
    expect(claudeArgs(sub, fixture)).toBe("--settings /tmp/settings.json hello");
  });

  test("シンボリックリンク越しに窓口のディレクトリへ入っても付ける", () => {
    const fixture = makeFixture();
    const link = join(fixture.root, "link");
    symlinkSync(fixture.concierge, link);
    expect(claudeArgs(link, fixture)).toContain("--append-system-prompt-file");
  });
});
