// ClaudeSessionLog の統合テスト。Swift 版 `ClaudeSessionLogTests.swift` のケースを対で
// 移植し、watch_dir 契約（found / projects 親 / 空文字の 3 状態）を固定する。
// subagent / workflow JOIN のケースは fixture ディレクトリ構造ごと検証する。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeSessionLog } from "./claudeSessionLog";

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
