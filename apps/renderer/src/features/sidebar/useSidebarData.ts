import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { rpcGitBranchList, rpcGitWorktreeList, rpcTaskAdd, rpcTaskUpdate } from "./rpc";
import type { BranchChangePayload, WorktreeChangePayload } from "./rpc";

/**
 * サイドバーのデータ取得・状態管理。
 *
 * 全 repo を per-rootDir で並列に管理する：
 * - `fetchRepo(rootDir)` を 1 単位として、新規追加 / push event / 明示リフレッシュで使い回す
 * - active dir に紐づく terminal title を、その dir 所属 repo の Task 名に同期する
 */
export function useSidebarData() {
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  /** repo ごとの fetch 世代カウンタ。並行 fetch で stale なレスポンスを破棄するため */
  const fetchGenByRoot = new Map<string, number>();

  /** 1 つの repo の worktrees / branches を取り直して repoStore を更新 */
  async function fetchRepo(rootDir: string) {
    const repo = repoStore.repos[rootDir];
    if (repo === undefined || !repo.isGitRepo) return;
    const gen = (fetchGenByRoot.get(rootDir) ?? 0) + 1;
    fetchGenByRoot.set(rootDir, gen);

    const result = await tryCatch(
      Promise.all([rpcGitWorktreeList({ dir: rootDir }), rpcGitBranchList({ dir: rootDir })]),
    );
    if (!result.ok) {
      notify.error(`Failed to fetch repo data: ${repo.repoName}`, result.error);
      return;
    }
    if (fetchGenByRoot.get(rootDir) !== gen) return;
    const [wtRes, branchRes] = result.value;
    const wtList = wtRes.worktrees;
    const wtBranches = new Set(wtList.map((wt) => wt.branch).filter(Boolean));
    const newFreeBranches = branchRes.branches.filter((b) => !wtBranches.has(b));

    // 外部で削除された worktree のターミナルを cleanup（この repo の旧 worktrees に限定）
    const newPaths = new Set(wtList.map((wt) => wt.path));
    const stalePaths = repo.worktrees.map((w) => w.path).filter((p) => !newPaths.has(p));

    repoStore.updateRepoData(rootDir, wtList, newFreeBranches);

    for (const dir of stalePaths) terminalStore.remove(dir);
  }

  async function fetchAllRepos() {
    await Promise.allSettled(repoStore.dirOrder.map((d) => fetchRepo(d)));
  }

  /** 現在 active な dir を所有する repo を fetch。push event 駆動 */
  function fetchOwnerOfActive() {
    const dir = worktreeStore.dir;
    if (dir === undefined) return;
    const owning = repoStore.findRepoOwning(dir);
    if (owning) void fetchRepo(owning.rootDir);
  }

  // 新規 repo が追加されたら即 fetch
  watch(
    () => [...repoStore.dirOrder],
    (next, prev) => {
      const prevSet = new Set(prev);
      for (const dir of next) {
        if (!prevSet.has(dir)) void fetchRepo(dir);
      }
    },
    { immediate: true },
  );

  // active dir 切り替え時: done バッジ消化 + 所属 repo を最新化
  watch(
    () => worktreeStore.dir,
    (dir) => {
      if (dir === undefined) return;
      terminalStore.clearDoneStates(dir);
      const owning = repoStore.findRepoOwning(dir);
      if (owning) void fetchRepo(owning.rootDir);
    },
    { immediate: true },
  );

  // --- ターミナルタイトル → 同 dir の Task タイトル同期 ---
  // RPC 処理中に来た更新は pendingSync に退避し、完了後に再実行する

  let titleSyncing = false;
  let pendingSync: { dir: string; title: string } | undefined;

  async function syncTaskTitle(targetDir: string, title: string) {
    const owning = repoStore.findRepoOwning(targetDir);
    if (owning === undefined) return;
    const projectDir = owning.rootDir;
    const wt = owning.worktrees.find((w) => w.path === targetDir);
    if (!wt) return;

    if (wt.task === undefined) {
      const addResult = await tryCatch(
        rpcTaskAdd({
          dir: projectDir,
          body: title,
          worktreeDir: targetDir,
          prNumber: 0,
          issueNumber: 0,
        }),
      );
      if (addResult.ok && addResult.value.task !== undefined) {
        const freshRepo = repoStore.repos[projectDir];
        const freshWt = freshRepo?.worktrees.find((w) => w.path === targetDir);
        if (freshWt) freshWt.task = addResult.value.task;
      }
      return;
    }
    const [firstLine] = wt.task.body.split("\n");
    // 手動設定されたタイトルをターミナルタイトルで上書きしない
    if (firstLine.trim() !== "") return;
    const newBody = [title, ...wt.task.body.split("\n").slice(1)].join("\n");
    const result = await tryCatch(
      rpcTaskUpdate({ dir: projectDir, id: wt.task.id, body: newBody }),
    );
    if (result.ok && result.value.task !== undefined) {
      const freshRepo = repoStore.repos[projectDir];
      const freshWt = freshRepo?.worktrees.find((w) => w.path === targetDir);
      if (freshWt) freshWt.task = result.value.task;
    }
  }

  async function drainTitleSync(dir: string, title: string) {
    if (titleSyncing) {
      pendingSync = { dir, title };
      return;
    }
    titleSyncing = true;
    try {
      await syncTaskTitle(dir, title);
      while (pendingSync !== undefined) {
        const next = pendingSync;
        pendingSync = undefined;
        await syncTaskTitle(next.dir, next.title);
      }
    } finally {
      titleSyncing = false;
    }
  }

  watch(
    () => terminalStore.lastTitleUpdate,
    (update) => {
      if (!update?.title) return;
      const dir = worktreeStore.dir;
      if (!dir) return;
      if (terminalStore.getPaneDir(update.leafId) !== dir) return;
      // Claude Code のステータスプレフィックス（✳ + Braille dots）を除去
      const title = update.title.replace(/^[✳⠀-⣿] /, "");
      if (!title) return;
      // セッション開始・レジューム時の汎用タイトルで Task を上書きしない
      if (title === "Claude Code") return;
      void drainTitleSync(dir, title);
    },
  );

  const cleanups: Array<() => void> = [];
  onMounted(() => {
    // gitStatusChange / branchChange / worktreeChange は active dir watch から発火するので
    // active を所有する repo だけを refetch する。他 repo は別経路で更新する
    cleanups.push(onMessage("gitStatusChange", () => fetchOwnerOfActive()));
    cleanups.push(onMessage<BranchChangePayload>("branchChange", () => fetchOwnerOfActive()));
    cleanups.push(onMessage<WorktreeChangePayload>("worktreeChange", () => fetchOwnerOfActive()));
  });
  onUnmounted(() => {
    for (const cleanup of cleanups) cleanup();
  });

  return {
    fetchRepo,
    fetchAllRepos,
  };
}
