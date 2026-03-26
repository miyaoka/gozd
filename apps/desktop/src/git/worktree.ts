import fsp from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { tryCatch } from "@gozd/shared";
import type { WorktreeEntry } from "@gozd/rpc";
import { projectKey } from "../projectKey";
import { resolveCreatableFsPath, resolveExistingFsPath, resolveGitPath } from "../security";
import { getGitStatus, countChanges } from "./status";
import { assertBranchName } from "./branch";

const WORKTREE_BASE = path.join(homedir(), ".local", "share", "gozd", "worktrees");

/** プロジェクトディレクトリに対応する worktree ルートを返す */
function getWorktreeRoot(projectDir: string): string {
  return path.join(WORKTREE_BASE, projectKey(projectDir));
}

/**
 * リモートブランチを fetch し、ローカルブランチを作成して worktree 化する。
 * リモートに存在しない場合は false を返す。
 */
async function createWorktreeFromRemote({
  cwd,
  branch,
  wtPath,
}: {
  cwd: string;
  branch: string;
  wtPath: string;
}): Promise<boolean> {
  const fetchProc = Bun.spawn(["git", "fetch", "origin", branch], {
    cwd,
    stderr: "pipe",
  });
  await fetchProc.exited;
  if (fetchProc.exitCode !== 0) return false;

  const wtProc = Bun.spawn(["git", "worktree", "add", "-b", branch, wtPath, `origin/${branch}`], {
    cwd,
    stderr: "pipe",
  });
  await wtProc.exited;
  if (wtProc.exitCode !== 0) {
    const stderr = await new Response(wtProc.stderr).text();
    throw new Error(`git worktree add failed: ${stderr.trim() || `exit code ${wtProc.exitCode}`}`);
  }
  return true;
}

export async function addWorktree({
  cwd,
  worktreeDir,
  branch,
  symlinks,
}: {
  cwd: string;
  worktreeDir: string;
  branch: string;
  /** メインリポジトリからシンボリックリンクする対象パス */
  symlinks?: string[];
}): Promise<WorktreeEntry> {
  const worktreeRoot = getWorktreeRoot(cwd);
  await fsp.mkdir(worktreeRoot, { recursive: true });
  const wtPath = await resolveCreatableFsPath(worktreeRoot, worktreeDir);

  assertBranchName(branch);

  // まず -b で新規ブランチ作成を試み、既存ブランチなら -b なしでリトライ。
  // タイムスタンプベースの名前では事実上リトライは発生しない
  const newBranchProc = Bun.spawn(["git", "worktree", "add", "-b", branch, wtPath], {
    cwd,
    stderr: "pipe",
  });
  await newBranchProc.exited;

  if (newBranchProc.exitCode !== 0) {
    // ブランチが既に存在するかをロケール非依存で判定（stderr のメッセージは LANG で変わるため）
    const branchExists =
      (await Bun.spawn(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd })
        .exited) === 0;

    if (branchExists) {
      const existingProc = Bun.spawn(["git", "worktree", "add", wtPath, branch], {
        cwd,
        stderr: "pipe",
      });
      await existingProc.exited;
      if (existingProc.exitCode !== 0) {
        const retryStderr = await new Response(existingProc.stderr).text();
        throw new Error(
          `git worktree add failed: ${retryStderr.trim() || `exit code ${existingProc.exitCode}`}`,
        );
      }
    } else {
      // リモートブランチからローカルブランチを作成して worktree 化する
      const remoteResult = await createWorktreeFromRemote({ cwd, branch, wtPath });
      if (!remoteResult) {
        const stderr = await new Response(newBranchProc.stderr).text();
        throw new Error(
          `git worktree add failed: ${stderr.trim() || `exit code ${newBranchProc.exitCode}`}`,
        );
      }
    }
  }

  // メインリポジトリから指定パスをシンボリックリンク
  if (symlinks && symlinks.length > 0) {
    await createWorktreeSymlinks(cwd, wtPath, symlinks);
  }

  // HEAD は後続の gitWorktreeList で取得されるため、作成時は省略
  return { path: wtPath, head: "", branch, isMain: false };
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

/**
 * メインリポジトリの指定パスを worktree にシンボリックリンクする。
 * ベストエフォート: パス検証失敗、存在しないソース、既存の dest、symlink 失敗はスキップする。
 */
async function createWorktreeSymlinks(
  mainRepoDir: string,
  wtPath: string,
  targets: string[],
): Promise<void> {
  await Promise.all(
    targets.map(async (target) => {
      // ソース: realpath で実パスを検証し、リポジトリ外へのトラバーサルを防止
      const sourceResult = await tryCatch(resolveExistingFsPath(mainRepoDir, target));
      if (!sourceResult.ok) return;

      // ネストされたパスに対応するため、親ディレクトリを作成
      // resolveGitPath で論理パスのトラバーサルを事前チェックし、
      // mkdir 後に resolveExistingFsPath で実パスが worktree 内に収まることを検証する
      const targetDir = path.dirname(target);
      if (targetDir !== ".") {
        const logicalResult = tryCatch(() => resolveGitPath(wtPath, targetDir));
        if (!logicalResult.ok) return;

        const mkdirResult = await tryCatch(fsp.mkdir(logicalResult.value, { recursive: true }));
        if (!mkdirResult.ok) return;

        // mkdir で作成されたパスが symlink 経由で worktree 外に出ていないか実パスで検証
        const parentCheck = await tryCatch(resolveExistingFsPath(wtPath, targetDir));
        if (!parentCheck.ok) return;
      }

      // dest: 親ディレクトリの realpath を検証し、worktree 外への書き込みを防止
      const destResult = await tryCatch(resolveCreatableFsPath(wtPath, target));
      if (!destResult.ok) return;

      // worktree 側に既に存在する場合はスキップ（git checkout で取得済みの可能性）
      const destExists = await tryCatch(fsp.lstat(destResult.value));
      if (destExists.ok) return;

      // symlink 作成失敗はスキップ（worktree 自体の作成は成功扱い）
      await tryCatch(fsp.symlink(sourceResult.value, destResult.value));
    }),
  );
}

/** 各 worktree の git status を並列取得して changeCounts を付与する */
export async function attachChangeCounts(entries: WorktreeEntry[]): Promise<WorktreeEntry[]> {
  await Promise.all(
    entries.map(async (entry) => {
      const { statuses } = await getGitStatus(entry.path);
      entry.changeCounts = countChanges(statuses);
    }),
  );
  return entries;
}
