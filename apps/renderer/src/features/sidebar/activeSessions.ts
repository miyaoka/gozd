import type { Task, WorktreeEntry } from "@gozd/rpc";
import type { RepoState } from "../../shared/repo";
import { repoDirEntries } from "../../shared/repo";
import type { ClaudeStatus } from "../terminal";
import { branchLabel, compareTaskOrder } from "./utils";

/** live な Claude セッションを持つ 1 task。行の描画に必要な値だけを持つ */
interface ActiveSessionEntry {
  task: Task;
  status: ClaudeStatus;
}

/**
 * 「動いているセッション」1 グループ = 1 worktree（非 git project は rootDir 自身）。
 *
 * repo → worktree → task の 3 階層を、下段では **2 階層（グループ + 行）** に圧縮する。
 * repo 名は worktree ラベルに畳み込む（`repoName · branch`）。狭いサイドバーで 3 階層の
 * 見出しを積むと、行 1 本に対して見出しが 2 本という比率になり一覧として読めない。
 */
export interface ActiveSessionGroup {
  /** メニュー / 選択で対象 repo を特定するための rootDir */
  rootDir: string;
  /** グループが指す dir。git repo は worktree path、非 git project は rootDir */
  dir: string;
  /** `repoName · branch`（非 git project は repoName のみ） */
  label: string;
  /** git repo のときだけ存在する。worktree 選択 emit にそのまま渡す */
  worktree: WorktreeEntry | undefined;
  entries: ActiveSessionEntry[];
}

/**
 * 動いている Claude セッションを worktree 単位にまとめる純関数。
 *
 * 母集団はアクティブ repo list ではなく repo プール全体（poolDirs）: セッションは repo list と
 * 無関係に全 dir で動くため、list で絞ると「動いているのに一覧に出ない」セッションが生まれる。
 * repo → dir の分岐は `repoDirEntries` が SSOT（非 git project は rootDir 自身が dir で
 * worktree を持たない）。
 *
 * session を持たない task（未起動 / resume 待ち）は除外する。ここは「いま何が動いているか」の
 * 面であり、起動可能な候補の一覧ではない。
 *
 * live session はあるが task がまだ紐づいていない dir（SessionStart hook が届く前の窓 /
 * 非 git project）もグループとして残す。行が 0 本でもラベルは出て、「起動中の何かがある」
 * ことは伝わる。
 */
export function collectActiveSessionGroups(
  poolDirs: readonly string[],
  repos: Readonly<Record<string, RepoState>>,
  claudeActiveDirs: ReadonlySet<string>,
  statusOf: (sessionId: string) => ClaudeStatus | undefined,
): ActiveSessionGroup[] {
  const groups: ActiveSessionGroup[] = [];
  for (const rootDir of poolDirs) {
    const repo = repos[rootDir];
    if (repo === undefined) continue;

    for (const { dir, worktree } of repoDirEntries(repo)) {
      if (!claudeActiveDirs.has(dir)) continue;
      const tasks = worktree?.tasks ?? [];
      const entries = tasks
        .flatMap<ActiveSessionEntry>((task) => {
          if (task.sessionId === "") return [];
          const status = statusOf(task.sessionId);
          return status === undefined ? [] : [{ task, status }];
        })
        .sort((a, b) => compareTaskOrder(a.task, b.task));
      groups.push({
        rootDir,
        dir,
        label:
          worktree === undefined
            ? repo.repoName
            : `${repo.repoName} · ${branchLabel(worktree.branch)}`,
        worktree,
        entries,
      });
    }
  }
  return groups;
}
