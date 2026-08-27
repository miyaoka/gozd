// gozd-cli のコマンド構築ロジックのテスト。Swift 版 GozdCLI の契約
// （channel 導出 / HookMessage 組み立て / pending_work 畳み込み）を固定する。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHookMessage,
  launchRequestDirFromSocketPath,
  parseNewWorktreeArgs,
  parseStdinJson,
  resolveSocketPath,
  writeLaunchRequest,
} from "./cliOps";

describe("resolveSocketPath", () => {
  test("GOZD_SOCKET_PATH があればそれを使う", () => {
    expect(resolveSocketPath({ GOZD_SOCKET_PATH: "/tmp/x.sock" })).toBe("/tmp/x.sock");
  });

  test("無ければ stable channel に fallback（Swift 版と同じ）", () => {
    expect(resolveSocketPath({})).toBe(join(tmpdir(), "gozd-stable.sock"));
    expect(resolveSocketPath({ GOZD_SOCKET_PATH: "" })).toBe(join(tmpdir(), "gozd-stable.sock"));
  });
});

describe("launchRequestDirFromSocketPath", () => {
  test("socket ファイル名から channel を抽出する", () => {
    expect(launchRequestDirFromSocketPath("/tmp/gozd-electron-stable.sock")).toBe(
      join(tmpdir(), "gozd-electron-stable-launch"),
    );
    expect(launchRequestDirFromSocketPath("/tmp/gozd-dev.sock")).toBe(
      join(tmpdir(), "gozd-dev-launch"),
    );
  });

  test("worktree hash 付き dev channel も抽出できる（並列 pnpm dev の per-worktree socket）", () => {
    expect(launchRequestDirFromSocketPath("/tmp/gozd-dev-a1b2c3d4e5f6.sock")).toBe(
      join(tmpdir(), "gozd-dev-a1b2c3d4e5f6-launch"),
    );
  });

  test("形式外は stable 扱い", () => {
    expect(launchRequestDirFromSocketPath("/tmp/other.sock")).toBe(
      join(tmpdir(), "gozd-stable-launch"),
    );
  });
});

describe("writeLaunchRequest", () => {
  test("channel 由来の dir に targetPath JSON を書き出す", () => {
    const socketPath = join(tmpdir(), "gozd-clitest.sock");
    const dir = join(tmpdir(), "gozd-clitest-launch");
    rmSync(dir, { recursive: true, force: true });

    writeLaunchRequest("/Users/foo/repo", socketPath);
    const [entry] = readdirSync(dir);
    expect(entry).toMatch(/\.json$/);
    if (entry === undefined) throw new Error("unreachable");
    expect(JSON.parse(readFileSync(join(dir, entry), "utf8"))).toEqual({
      targetPath: "/Users/foo/repo",
    });

    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});

describe("buildHookMessage", () => {
  test("stdin JSON の代表フィールドと GOZD_PTY_ID を詰める", () => {
    const hook = buildHookMessage(
      "done",
      {
        last_assistant_message: "hello",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "sid-1",
        source: "resume",
      },
      { GOZD_PTY_ID: "7" },
    );
    expect(hook.event).toBe("done");
    expect(hook.ptyId).toBe(7);
    expect(hook.lastAssistantMessage).toBe("hello");
    expect(hook.toolName).toBe("Bash");
    expect(JSON.parse(hook.toolInput)).toEqual({ command: "ls" });
    expect(hook.sessionId).toBe("sid-1");
    expect(hook.source).toBe("resume");
  });

  test("tool_input が string ならそのまま保持する", () => {
    const hook = buildHookMessage("needs-input", { tool_input: "raw text" }, {});
    expect(hook.toolInput).toBe("raw text");
  });

  test("GOZD_PTY_ID 不正 / 欠落は ptyId 0", () => {
    expect(buildHookMessage("running", {}, {}).ptyId).toBe(0);
    expect(buildHookMessage("running", {}, { GOZD_PTY_ID: "abc" }).ptyId).toBe(0);
  });

  test("pending_work は background_tasks / session_crons の OR（欠落 = pending なし）", () => {
    expect(buildHookMessage("done", {}, {}).pendingWork).toBe(false);
    expect(
      buildHookMessage("done", { background_tasks: [], session_crons: [] }, {}).pendingWork,
    ).toBe(false);
    expect(buildHookMessage("done", { background_tasks: [{}] }, {}).pendingWork).toBe(true);
    expect(buildHookMessage("done", { session_crons: [{}] }, {}).pendingWork).toBe(true);
  });

  test("teammate 型の background_tasks は pending_work に数えない（idle でも running のまま残るため）", () => {
    // teammate のみ → pending なし（hasTeammateTask だけ立つ）
    const teammateOnly = buildHookMessage(
      "done",
      { background_tasks: [{ id: "tk1", type: "teammate", status: "running" }] },
      {},
    );
    expect(teammateOnly.pendingWork).toBe(false);
    expect(teammateOnly.hasTeammateTask).toBe(true);

    // teammate + subagent 混在 → subagent 分で pending
    const mixed = buildHookMessage(
      "done",
      {
        background_tasks: [
          { id: "tk1", type: "teammate", status: "running" },
          { id: "a1", type: "subagent", status: "running" },
        ],
      },
      {},
    );
    expect(mixed.pendingWork).toBe(true);
    expect(mixed.hasTeammateTask).toBe(true);

    // teammate なし → hasTeammateTask は立たない
    expect(
      buildHookMessage("done", { background_tasks: [{ type: "subagent" }] }, {}).hasTeammateTask,
    ).toBe(false);
    expect(buildHookMessage("done", {}, {}).hasTeammateTask).toBe(false);
  });

  test("agent_id / teammate_name は subagent lifecycle hook の stdin から詰める（欠落は空文字列）", () => {
    const start = buildHookMessage("subagent-start", { agent_id: "apr-1-reviewer-90ed05bf" }, {});
    expect(start.agentId).toBe("apr-1-reviewer-90ed05bf");
    expect(start.teammateName).toBe("");

    const idle = buildHookMessage("teammate-idle", { teammate_name: "pr-1-reviewer" }, {});
    expect(idle.teammateName).toBe("pr-1-reviewer");
    expect(idle.agentId).toBe("");

    expect(buildHookMessage("done", {}, {}).agentId).toBe("");
  });
});

describe("parseStdinJson", () => {
  test("空 / 壊れ / 非オブジェクトは空オブジェクトに倒す（Swift 版と同じ lenient 契約）", () => {
    expect(parseStdinJson("")).toEqual({});
    expect(parseStdinJson("  \n")).toEqual({});
    expect(parseStdinJson("{ broken")).toEqual({});
    expect(parseStdinJson("[1,2]")).toEqual({});
    expect(parseStdinJson('"text"')).toEqual({});
    expect(parseStdinJson('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("parseNewWorktreeArgs", () => {
  test("--title だけで cwd 起点の message になる", () => {
    const parsed = parseNewWorktreeArgs(["--title", "fix login"], "/repo");
    expect(parsed).toEqual({
      ok: true,
      value: { dir: "/repo", title: "fix login", prefill: "", ghRef: undefined },
    });
  });

  test("--flag=value 形式も受ける", () => {
    const parsed = parseNewWorktreeArgs(["--title=fix", "--prefill=do it"], "/repo");
    expect(parsed.ok && parsed.value.prefill).toBe("do it");
  });

  test("--dir は cwd 基準で絶対パスに解決する", () => {
    const parsed = parseNewWorktreeArgs(["--title", "t", "--dir", "../other"], "/repo/sub");
    expect(parsed.ok && parsed.value.dir).toBe("/repo/other");
  });

  test("--issue / --pr は ghRef になる", () => {
    const issue = parseNewWorktreeArgs(["--title", "t", "--issue", "42"], "/repo");
    expect(issue.ok && issue.value.ghRef).toEqual({ kind: "GH_REF_KIND_ISSUE", number: 42 });
    const pr = parseNewWorktreeArgs(["--title", "t", "--pr", "7"], "/repo");
    expect(pr.ok && pr.value.ghRef).toEqual({ kind: "GH_REF_KIND_PR", number: 7 });
  });

  test("--title 無しは失敗する（タイトル無しの task はサイドバーで見分けが付かない）", () => {
    expect(parseNewWorktreeArgs([], "/repo")).toEqual({ ok: false, error: "--title is required" });
  });

  test("--issue と --pr の同時指定は失敗する", () => {
    const parsed = parseNewWorktreeArgs(["--title", "t", "--issue", "1", "--pr", "2"], "/repo");
    expect(parsed).toEqual({
      ok: false,
      error: "--issue and --pr are mutually exclusive",
    });
  });

  test("番号でない --issue は失敗する", () => {
    const parsed = parseNewWorktreeArgs(["--title", "t", "--issue", "#42"], "/repo");
    expect(parsed.ok).toBe(false);
  });

  test("未知のオプションと値の無いオプションは失敗する", () => {
    expect(parseNewWorktreeArgs(["--nope", "x"], "/repo")).toEqual({
      ok: false,
      error: "unknown option: --nope",
    });
    expect(parseNewWorktreeArgs(["--title"], "/repo")).toEqual({
      ok: false,
      error: "--title requires a value",
    });
  });
});
