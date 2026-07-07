// ClaudeSessionLog の統合テスト。Swift 版 `ClaudeSessionLogTests.swift` のケースを対で
// 移植し、watch_dir 契約（found / projects 親 / 空文字の 3 状態）を固定する。
// subagent / workflow JOIN のケースは fixture ディレクトリ構造ごと検証する。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectKey } from "../taskStore";
import { listReviveSessions, readClaudeSessionLog } from "./claudeSessionLog";

const SID = "11111111-2222-3333-4444-555555555555";

describe("ClaudeSessionLog", () => {
  const tempDirs: string[] = [];

  function makeTempProjectsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-claude-log-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("空 projects dir では found=false / watchDir = projects 親", () => {
    const projects = makeTempProjectsDir();
    const result = readClaudeSessionLog(SID, projects);
    expect(result.found).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.watchDir).toBe(projects);
  });

  test("該当 jsonl を含む projectDir が見つかれば found=true / watchDir = その親", () => {
    const projects = makeTempProjectsDir();
    const projectDir = join(projects, "-Users-foo-bar");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${SID}.jsonl`), '{"type":"user"}\n');

    const result = readClaudeSessionLog(SID, projects);
    expect(result.found).toBe(true);
    expect(result.watchDir).toBe(projectDir);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.kind).toBe("main");
    expect(result.entries[0]?.id).toBe(SID);
    expect(result.entries[0]?.content).toBe('{"type":"user"}\n');
  });

  test("無関係な projectDir しか無ければ found=false / watchDir = projects 親", () => {
    const projects = makeTempProjectsDir();
    const projectDir = join(projects, "-Users-foo-bar");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "99999999-8888-7777-6666-555555555555.jsonl"), "{}\n");

    const result = readClaudeSessionLog(SID, projects);
    expect(result.found).toBe(false);
    expect(result.watchDir).toBe(projects);
  });

  test("unsafe sessionId は watchDir = projects 親 / entries 空", () => {
    const projects = makeTempProjectsDir();
    const result = readClaudeSessionLog("../escape", projects);
    expect(result.found).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.watchDir).toBe(projects);
  });

  test("projects 親 dir が存在しなければ watchDir 空文字 (renderer 側で error 化)", () => {
    const missing = join(tmpdir(), "gozd-claude-log-missing", "projects");
    const result = readClaudeSessionLog(SID, missing);
    expect(result.found).toBe(false);
    expect(result.watchDir).toBe("");
  });

  test("subagents: agent-*.jsonl を agentId 昇順で読み meta.json を JOIN する", () => {
    const projects = makeTempProjectsDir();
    const projectDir = join(projects, "-Users-foo-bar");
    const subagentsDir = join(projectDir, SID, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(projectDir, `${SID}.jsonl`), "main\n");
    writeFileSync(join(subagentsDir, "agent-bbb.jsonl"), "sub-b\n");
    writeFileSync(join(subagentsDir, "agent-aaa.jsonl"), "sub-a\n");
    writeFileSync(
      join(subagentsDir, "agent-aaa.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "search files", toolUseId: "toolu_1", name: "scout" }),
    );

    const result = readClaudeSessionLog(SID, projects);
    expect(result.entries.map((entry) => entry.id)).toEqual([SID, "aaa", "bbb"]);
    const [, agentA, agentB] = result.entries;
    expect(agentA?.kind).toBe("subagent");
    expect(agentA?.label).toBe("search files");
    expect(agentA?.agentType).toBe("Explore");
    expect(agentA?.parentToolUseId).toBe("toolu_1");
    expect(agentA?.name).toBe("scout");
    // meta.json 不在の subagent はラベル空で表示される
    expect(agentB?.label).toBe("");
  });

  test("workflow subagents: wf json の workflowProgress から表示メタを JOIN する", () => {
    const projects = makeTempProjectsDir();
    const projectDir = join(projects, "-Users-foo-bar");
    const sessionDir = join(projectDir, SID);
    const wfAgentsDir = join(sessionDir, "subagents", "workflows", "wf_abc123");
    const wfMetaDir = join(sessionDir, "workflows");
    mkdirSync(wfAgentsDir, { recursive: true });
    mkdirSync(wfMetaDir, { recursive: true });
    writeFileSync(join(projectDir, `${SID}.jsonl`), "main\n");
    writeFileSync(join(wfAgentsDir, "agent-w1.jsonl"), "wf-agent\n");
    writeFileSync(
      join(wfMetaDir, "wf_abc123.json"),
      JSON.stringify({
        workflowName: "review-changes",
        workflowProgress: [
          { type: "workflow_agent", agentId: "w1", label: "review:bugs", phaseTitle: "Review", agentType: null },
        ],
      }),
    );

    const result = readClaudeSessionLog(SID, projects);
    expect(result.entries.length).toBe(2);
    const [, wfAgent] = result.entries;
    expect(wfAgent?.kind).toBe("subagent");
    expect(wfAgent?.id).toBe("w1");
    expect(wfAgent?.workflowRunId).toBe("wf_abc123");
    expect(wfAgent?.workflowName).toBe("review-changes");
    expect(wfAgent?.phaseTitle).toBe("Review");
    expect(wfAgent?.label).toBe("review:bugs");
    // agentType: null は空文字に倒す
    expect(wfAgent?.agentType).toBe("");
  });
});

describe("listReviveSessions", () => {
  const tempDirs: string[] = [];

  function makeTemp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** repo dir から算出した projectKey 配下の worktrees パス（leaf は未生成 = 削除済み worktree を模す）。 */
  async function gozdCwd(repoDir: string, worktreesRoot: string, leaf: string): Promise<string> {
    return join(worktreesRoot, await resolveProjectKey(repoDir), leaf);
  }

  function writeSession(projects: string, encName: string, sid: string, lines: string): string {
    const projectDir = join(projects, encName);
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, `${sid}.jsonl`);
    writeFileSync(file, lines);
    return file;
  }

  test("削除済み(cwd 不在)の gozd worktree セッションを列挙し、末尾の branch/aiTitle/timestamp を採る", async () => {
    const repo = makeTemp("gozd-revive-repo-");
    const projects = makeTemp("gozd-revive-projects-");
    const wtRoot = makeTemp("gozd-revive-wtroot-");
    const cwd = await gozdCwd(repo, wtRoot, "20260101_120000");
    const sid = "aaaaaaaa-1111-2222-3333-444444444444";
    writeSession(
      projects,
      "enc-1",
      sid,
      `{"type":"user","cwd":"${cwd}","gitBranch":"20260101_120000","timestamp":"2026-01-01T12:00:00.000Z"}\n` +
        `{"type":"ai-title","aiTitle":"Fix the thing","gitBranch":"feature/foo","timestamp":"2026-01-01T12:05:00.000Z","cwd":"${cwd}"}\n`,
    );

    const sessions = await listReviveSessions(repo, projects, wtRoot);
    expect(sessions.length).toBe(1);
    const [s] = sessions;
    expect(s.sessionId).toBe(sid);
    expect(s.cwd).toBe(cwd);
    expect(s.worktreeDir).toBe("20260101_120000");
    expect(s.branch).toBe("feature/foo");
    expect(s.title).toBe("Fix the thing");
    expect(s.lastActivity).toBe(Date.parse("2026-01-01T12:05:00.000Z"));
    expect(s.sizeBytes).toBeGreaterThan(0);
  });

  test("cwd が実在する worktree は除外する", async () => {
    const repo = makeTemp("gozd-revive-repo-");
    const projects = makeTemp("gozd-revive-projects-");
    const wtRoot = makeTemp("gozd-revive-wtroot-");
    const cwd = await gozdCwd(repo, wtRoot, "20260101_120000");
    mkdirSync(cwd, { recursive: true }); // 実在させる
    writeSession(projects, "enc-1", "aaaaaaaa-1111-2222-3333-444444444444", `{"cwd":"${cwd}"}\n`);
    expect(await listReviveSessions(repo, projects, wtRoot)).toEqual([]);
  });

  test("gozd worktrees base の外の cwd は除外する", async () => {
    const repo = makeTemp("gozd-revive-repo-");
    const projects = makeTemp("gozd-revive-projects-");
    const wtRoot = makeTemp("gozd-revive-wtroot-");
    const outside = join(makeTemp("gozd-revive-outside-"), "20260101_120000"); // base 外・不在
    writeSession(projects, "enc-1", "aaaaaaaa-1111-2222-3333-444444444444", `{"cwd":"${outside}"}\n`);
    expect(await listReviveSessions(repo, projects, wtRoot)).toEqual([]);
  });

  test("代表 jsonl が空でも兄弟セッションを silent drop しない", async () => {
    const repo = makeTemp("gozd-revive-repo-");
    const projects = makeTemp("gozd-revive-projects-");
    const wtRoot = makeTemp("gozd-revive-wtroot-");
    const cwd = await gozdCwd(repo, wtRoot, "20260101_120000");
    // 同 projectDir に空 jsonl と正常 jsonl を同居させる（readdir 先頭が空になっても救う）
    const projectDir = join(projects, "enc-1");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "00000000-0000-0000-0000-000000000000.jsonl"), "");
    const validSid = "aaaaaaaa-1111-2222-3333-444444444444";
    writeFileSync(
      join(projectDir, `${validSid}.jsonl`),
      `{"type":"ai-title","aiTitle":"Real session","gitBranch":"feature/foo","timestamp":"2026-01-01T12:05:00.000Z","cwd":"${cwd}"}\n`,
    );

    const sessions = await listReviveSessions(repo, projects, wtRoot);
    const valid = sessions.find((s) => s.sessionId === validSid);
    expect(valid?.title).toBe("Real session");
    expect(valid?.branch).toBe("feature/foo");
  });

  test("timestamp が無いセッションは lastActivity を mtime にフォールバックする", async () => {
    const repo = makeTemp("gozd-revive-repo-");
    const projects = makeTemp("gozd-revive-projects-");
    const wtRoot = makeTemp("gozd-revive-wtroot-");
    const cwd = await gozdCwd(repo, wtRoot, "20260101_120000");
    const sid = "aaaaaaaa-1111-2222-3333-444444444444";
    const file = writeSession(projects, "enc-1", sid, `{"cwd":"${cwd}","gitBranch":"feature/foo"}\n`);

    const [s] = await listReviveSessions(repo, projects, wtRoot);
    expect(s.lastActivity).toBe(statSync(file).mtimeMs);
  });
});
