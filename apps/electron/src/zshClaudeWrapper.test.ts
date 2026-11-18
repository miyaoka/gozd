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
  // 引数の境界を残すため、1 引数ずつ NUL で区切って出す
  writeFileSync(stub, `#!/bin/sh\nprintf '${ARGS_MARKER}'\nprintf '%s\\0' "$@"\n`);
  chmodSync(stub, 0o755);
  return { root, concierge, other, bin, home };
}

/** cwd で `claude` を実行し、スタブが受け取った引数を空白でつないで返す */
function claudeArgs(
  cwd: string,
  fixture: ReturnType<typeof makeFixture>,
  extraEnv: Record<string, string> = {},
): string {
  return claudeArgv(cwd, fixture, extraEnv).join(" ");
}

/** cwd で `claude` を実行し、スタブが受け取った引数を 1 引数ずつ返す */
function claudeArgv(
  cwd: string,
  fixture: ReturnType<typeof makeFixture>,
  extraEnv: Record<string, string> = {},
): string[] {
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
        ...extraEnv,
      },
    },
  );
  const start = output.indexOf(ARGS_MARKER);
  if (start === -1) throw new Error(`stub claude was not called: ${output}`);
  return output
    .slice(start + ARGS_MARKER.length)
    .split("\0")
    .slice(0, -1);
}

/** タスクの指示と窓口の指示を、中身の分かる実ファイルとして置く */
function writePrompts(fixture: ReturnType<typeof makeFixture>): Record<string, string> {
  const task = join(fixture.root, "task.md");
  const concierge = join(fixture.root, "concierge.md");
  writeFileSync(task, "TASK RULES\n");
  writeFileSync(concierge, "CONCIERGE RULES\n");
  return { GOZD_CLAUDE_TASK_PROMPT: task, GOZD_CONCIERGE_PROMPT: concierge };
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

  test("窓口以外ではタスクの指示だけをファイルで付ける", () => {
    const fixture = makeFixture();
    const prompts = writePrompts(fixture);
    expect(claudeArgs(fixture.other, fixture, prompts)).toBe(
      `--append-system-prompt-file ${prompts.GOZD_CLAUDE_TASK_PROMPT} --settings /tmp/settings.json hello`,
    );
  });

  test("窓口ではタスクの指示と窓口の指示をつないで 1 つの追記にする", () => {
    const fixture = makeFixture();
    const argv = claudeArgv(fixture.concierge, fixture, writePrompts(fixture));
    expect(argv.filter((arg) => arg.startsWith("--append-system-prompt"))).toEqual([
      "--append-system-prompt",
    ]);
    const prompt = argv[argv.indexOf("--append-system-prompt") + 1];
    expect(prompt).toContain("TASK RULES");
    expect(prompt).toContain("CONCIERGE RULES");
  });
});
