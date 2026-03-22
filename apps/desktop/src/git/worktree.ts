import fsp from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { tryCatch } from "@gozd/shared";
import type { WorktreeEntry } from "@gozd/rpc";
import { projectKey } from "../projectKey";
import { resolveCreatableFsPath } from "../security";
import { getGitStatus, countChanges } from "./status";
import { assertBranchName } from "./branch";

const WORKTREE_BASE = path.join(homedir(), ".local", "share", "gozd", "worktrees");

/** プロジェクトディレクトリに対応する worktree ルートを返す */
export function getWorktreeRoot(projectDir: string): string {
  return path.join(WORKTREE_BASE, projectKey(projectDir));
}

export async function addWorktree(
  cwd: string,
  worktreeDir: string,
  branch: string,
): Promise<WorktreeEntry> {
  const worktreeRoot = getWorktreeRoot(cwd);
  await fsp.mkdir(worktreeRoot, { recursive: true });
  const wtPath = await resolveCreatableFsPath(worktreeRoot, worktreeDir);

  assertBranchName(branch);

  // ブランチが既存かどうかを判定し、存在しなければ -b で新規作成。
  // 判定後〜作成前に同名ブランチが作られる競合は理論上あり得るが、
  // タイムスタンプベースの名前で実質衝突しない。万一衝突しても git がエラーを返す
  const branchExists =
    (await Bun.spawn(["git", "rev-parse", "--verify", `refs/heads/${branch}`], { cwd }).exited) ===
    0;
  const args = branchExists
    ? ["git", "worktree", "add", wtPath, branch]
    : ["git", "worktree", "add", "-b", branch, wtPath];

  const proc = Bun.spawn(args, { cwd, stderr: "pipe" });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git worktree add failed: ${stderr.trim() || `exit code ${proc.exitCode}`}`);
  }

  // 作成した worktree の情報を取得
  const headResult = await tryCatch(
    new Response(Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { cwd: wtPath }).stdout).text(),
  );
  const head = headResult.ok ? headResult.value.trim() : "";

  return { path: wtPath, head, branch, isMain: false };
}

export async function removeWorktree(cwd: string, wtPath: string, force?: boolean): Promise<void> {
  const args = ["git", "worktree", "remove"];
  if (force) args.push("--force");
  args.push(wtPath);

  const proc = Bun.spawn(args, { cwd, stderr: "pipe" });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git worktree remove failed: ${stderr.trim() || `exit code ${proc.exitCode}`}`);
  }
}

export async function getWorktreeList(cwd: string): Promise<WorktreeEntry[]> {
  const result = await tryCatch(
    new Response(Bun.spawn(["git", "worktree", "list", "--porcelain"], { cwd }).stdout).text(),
  );
  if (!result.ok) return [];

  const entries: WorktreeEntry[] = [];
  const blocks = result.value.trim().split("\n\n");
  let isFirst = true;

  for (const block of blocks) {
    const lines = block.split("\n");
    let wtPath = "";
    let head = "";
    let branch: string | undefined;
    let prunable = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length, "HEAD ".length + 7);
      } else if (line.startsWith("branch ")) {
        // refs/heads/main → main
        branch = line.slice("branch ".length).replace("refs/heads/", "");
      } else if (line.startsWith("prunable ")) {
        prunable = true;
      }
    }

    if (wtPath && !prunable) {
      entries.push({ path: wtPath, head, branch, isMain: isFirst });
    }
    isFirst = false;
  }

  return entries;
}

/** 各 worktree の git status を並列取得して changeCounts を付与する */
export async function attachChangeCounts(entries: WorktreeEntry[]): Promise<WorktreeEntry[]> {
  await Promise.all(
    entries.map(async (entry) => {
      const statuses = await getGitStatus(entry.path);
      entry.changeCounts = countChanges(statuses);
    }),
  );
  return entries;
}
