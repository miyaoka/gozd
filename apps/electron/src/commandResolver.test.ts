// commandResolver のテスト。Swift 版 CommandResolverTests の対応物。
//
// fake shell で spawn / marker 抽出 / キャッシュ / timeout の機構をユーザー環境の rc に
// 依存せず決定的に検証し、実シェルでは「`-i -l` で hang しない」ことだけを検証する。

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandResolveError, createCommandResolver } from "./commandResolver";

const workDir = mkdtempSync(join(tmpdir(), "gozd-resolver-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** `-i -l -c <script>` の呼び出し規約を受けて body を実行する fake shell を作る。
 * body 内では $4 が resolver の生成した script（printf marker + command -v） */
function makeFakeShell(name: string, body: string): string {
  const path = join(workDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** PATH 先頭に workDir を足してから script を評価する標準の fake shell。
 * countFile 指定時は呼び出しごとに 1 行追記する（キャッシュ検証用） */
function makeStandardFakeShell(name: string, countFile?: string): string {
  const count = countFile === undefined ? "" : `echo x >> "${countFile}"`;
  return makeFakeShell(
    name,
    `${count}\nPATH="${workDir}:$PATH"; export PATH\nexec /bin/sh -c "$4"`,
  );
}

function makeTargetCommand(name: string): string {
  const path = join(workDir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

function countInvocations(countFile: string): number {
  return readFileSync(countFile, "utf8")
    .split("\n")
    .filter((line) => line !== "").length;
}

describe("createCommandResolver (fake shell)", () => {
  test("PATH 上の実行可能コマンドを絶対パスに解決する", async () => {
    const targetPath = makeTargetCommand("gozd-resolve-target");
    const shell = makeStandardFakeShell("fake-shell-basic");
    const resolver = createCommandResolver({ shellOverride: shell });
    expect(await resolver.resolve("gozd-resolve-target")).toBe(targetPath);
  });

  test("未インストールコマンドは undefined を返し negative cache が効く", async () => {
    const countFile = join(workDir, "count-negative");
    writeFileSync(countFile, "");
    const shell = makeStandardFakeShell("fake-shell-negative", countFile);
    const resolver = createCommandResolver({ shellOverride: shell });

    expect(await resolver.resolve("gozd-no-such-command")).toBeUndefined();
    expect(await resolver.resolve("gozd-no-such-command")).toBeUndefined();
    expect(countInvocations(countFile)).toBe(1);
  });

  test("解決結果はキャッシュされ shell spawn は 1 回で済む", async () => {
    makeTargetCommand("gozd-cache-target");
    const countFile = join(workDir, "count-positive");
    writeFileSync(countFile, "");
    const shell = makeStandardFakeShell("fake-shell-cache", countFile);
    const resolver = createCommandResolver({ shellOverride: shell });

    await resolver.resolve("gozd-cache-target");
    await resolver.resolve("gozd-cache-target");
    expect(countInvocations(countFile)).toBe(1);
  });

  test("同時 resolve は inflight を共有し spawn は 1 回で済む", async () => {
    makeTargetCommand("gozd-inflight-target");
    const countFile = join(workDir, "count-inflight");
    writeFileSync(countFile, "");
    const shell = makeStandardFakeShell("fake-shell-inflight", countFile);
    const resolver = createCommandResolver({ shellOverride: shell });

    const [a, b] = await Promise.all([
      resolver.resolve("gozd-inflight-target"),
      resolver.resolve("gozd-inflight-target"),
    ]);
    expect(a).toBe(b as string);
    expect(countInvocations(countFile)).toBe(1);
  });

  test("invalidate 後は再解決する", async () => {
    makeTargetCommand("gozd-invalidate-target");
    const countFile = join(workDir, "count-invalidate");
    writeFileSync(countFile, "");
    const shell = makeStandardFakeShell("fake-shell-invalidate", countFile);
    const resolver = createCommandResolver({ shellOverride: shell });

    await resolver.resolve("gozd-invalidate-target");
    resolver.invalidate("gozd-invalidate-target");
    await resolver.resolve("gozd-invalidate-target");
    expect(countInvocations(countFile)).toBe(2);
  });

  test("shell 注入になりうる不正な name は spawn せずに throw する", async () => {
    const shell = makeStandardFakeShell("fake-shell-inject");
    const resolver = createCommandResolver({ shellOverride: shell });
    expect(resolver.resolve("git; rm -rf /")).rejects.toBeInstanceOf(CommandResolveError);
    expect(resolver.resolve("")).rejects.toBeInstanceOf(CommandResolveError);
    expect(resolver.resolve("あいう")).rejects.toBeInstanceOf(CommandResolveError);
  });

  test("shell が非 0 exit したら CommandResolveError", async () => {
    const shell = makeFakeShell("fake-shell-fail", "exit 3");
    const resolver = createCommandResolver({ shellOverride: shell });
    expect(resolver.resolve("git")).rejects.toThrow(/exited with code 3/);
  });

  test("marker を出力しない shell は CommandResolveError", async () => {
    const shell = makeFakeShell("fake-shell-no-marker", "echo something-else");
    const resolver = createCommandResolver({ shellOverride: shell });
    expect(resolver.resolve("git")).rejects.toThrow(/no markers/);
  });

  test("alias / function 出力（exit 0 だが非実行パス）は silent に採用せず CommandResolveError", async () => {
    // `command` builtin を function で shadow し、alias 定義風の文字列を marker 間に出させる
    const shell = makeFakeShell(
      "fake-shell-alias",
      `exec /bin/sh -c "command() { echo 'git: aliased to hub'; }; $4"`,
    );
    const resolver = createCommandResolver({ shellOverride: shell });
    expect(resolver.resolve("git")).rejects.toThrow(/non-executable or non-POSIX/);
  });

  test("execute bit 付き directory のパス出力は採用せず CommandResolveError", async () => {
    // workDir 自体（x bit の立った directory）の絶対パスを command -v の出力として返させる
    const shell = makeFakeShell(
      "fake-shell-dir",
      `exec /bin/sh -c "command() { echo '${workDir}'; }; $4"`,
    );
    const resolver = createCommandResolver({ shellOverride: shell });
    expect(resolver.resolve("git")).rejects.toThrow(/non-executable or non-POSIX/);
  });

  test("hang する shell は timeout で SIGKILL され CommandResolveError", async () => {
    const shell = makeFakeShell("fake-shell-hang", "sleep 30");
    const resolver = createCommandResolver({ shellOverride: shell, timeoutMs: 300 });
    expect(resolver.resolve("git")).rejects.toThrow(/timed out/);
  });

  test("shell バイナリ不在は CommandResolveError", async () => {
    const resolver = createCommandResolver({ shellOverride: join(workDir, "no-such-shell") });
    expect(resolver.resolve("git")).rejects.toBeInstanceOf(CommandResolveError);
  });
});

// 実シェルの `-i -l` は controlling tty が無いと job control 初期化で hang し得る
// （detached: true = setsid で回避している）。回避が効いていることを実シェルで検証する。
// 解決対象は「どの環境にも確実に存在し alias されにくい」sh を使う。
// CI（Linux runner）には /bin/zsh が無いため、存在するシェルだけを対象にする
const REAL_SHELLS = ["/bin/zsh", "/bin/sh"].filter((shell) => existsSync(shell));

describe.each(REAL_SHELLS)("createCommandResolver (実シェル %s)", (shell) => {
  // timeoutMs は bun:test の per-test default timeout (5s) より短くする。resolver 側の
  // SIGKILL + `timed out` 診断メッセージが bun のタイムアウトより先に発火することを保証し、
  // rc が hang する環境でも失敗原因が読み取れるようにする
  test("hang せず絶対パスを解決できる", async () => {
    const resolver = createCommandResolver({ shellOverride: shell, timeoutMs: 4000 });
    const path = await resolver.resolve("sh");
    expect(path).toBeDefined();
    expect(path!.startsWith("/")).toBe(true);
  });
});
