import { tryCatch } from "@gozd/shared";
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { rpcGitBranchList, rpcGitWorktreeList, rpcTaskAdd, rpcTaskUpdate } from "./rpc";
import type { BranchChangePayload, WorktreeChangePayload } from "./rpc";
import { dirName } from "./utils";

/**
 * サイドバーのデータ取得・状態管理。
 * 選択中 repo の worktrees / freeBranches を repoStore から読み出し、
 * push event 受信時に repoStore を再 fetch する。
 */
export function useSidebarData() {
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  /** fetchData の世代管理（並行実行で stale なレスポンスを破棄するため） */
  let fetchGen = 0;

  /** 選択中 repo の worktrees / freeBranches を派生 computed として公開 */
  const worktrees = computed(() => repoStore.selectedRepo?.worktrees ?? []);
  const freeBranches = computed(() => repoStore.selectedRepo?.freeBranches ?? []);

  /** root（main）worktree */
  const rootWorktree = computed(() => worktrees.value.find((wt) => wt.isMain));

  /** main 以外の worktree をディレクトリ名の降順で（新しい worktree が上） */
  const nonMainWorktrees = computed(() =>
    worktrees.value
      .filter((wt) => !wt.isMain)
      .sort((a, b) => dirName(b.path).localeCompare(dirName(a.path))),
  );

  const sortedBranches = computed(() => [...freeBranches.value].sort((a, b) => a.localeCompare(b)));

  /** 選択中 repo の worktrees / branches を再 fetch して repoStore を更新 */
  async function fetchData() {
    const repo = repoStore.selectedRepo;
    if (repo === undefined || !repo.isGitRepo) return;
    const rootDir = repo.rootDir;
    const gen = ++fetchGen;
    const result = await tryCatch(
      Promise.all([rpcGitWorktreeList({ dir: rootDir }), rpcGitBranchList({ dir: rootDir })]),
    );
    if (!result.ok) {
      notify.error("Failed to fetch sidebar data", result.error);
      return;
    }
    const [wtRes, branchRes] = result.value;
    if (gen !== fetchGen) return;
    const wtList = wtRes.worktrees;
    const wtBranches = new Set(wtList.map((wt) => wt.branch).filter(Boolean));
    const newFreeBranches = branchRes.branches.filter((b) => !wtBranches.has(b));
    repoStore.updateRepoData(rootDir, wtList, newFreeBranches);

    // 外部で削除された worktree のターミナルをクリーンアップ
    const wtPaths = new Set(wtList.map((wt) => wt.path));
    const staleDirs = terminalStore.visitedDirs.filter((dir) => !wtPaths.has(dir));
    for (const dir of staleDirs) {
      terminalStore.remove(dir);
    }
  }

  watch(
    () => worktreeStore.dir,
    (dir) => {
      void fetchData();
      // active dir に切り替わったら done バッジをクリア（既読消化）
      if (dir) {
        terminalStore.clearDoneStates(dir);
      }
    },
    { immediate: true },
  );

  // --- ターミナルタイトル → worktree Task タイトル同期 ---
  // RPC 処理中に来た更新は pendingTitle に退避し、完了後に再実行する

  let titleSyncing = false;
  let pendingSync: { dir: string; title: string } | undefined;

  async function syncTaskTitle(targetDir: string, title: string) {
    const projectDir = worktreeStore.dir;
    if (projectDir === undefined) return;
    const wt = worktrees.value.find((w) => w.path === targetDir);
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
        const freshWt = worktrees.value.find((w) => w.path === targetDir);
        if (freshWt) freshWt.task = addResult.value.task;
      }
      return;
    }
    const [firstLine] = wt.task.body.split("\n");
    // 手動設定されたタイトルをターミナルタイトルで上書きしない
    if (firstLine.trim() !== "") return;
    // タイトルが空の Task にターミナルタイトルを設定
    const newBody = [title, ...wt.task.body.split("\n").slice(1)].join("\n");
    const result = await tryCatch(
      rpcTaskUpdate({ dir: projectDir, id: wt.task.id, body: newBody }),
    );
    if (result.ok && result.value.task !== undefined) {
      const freshWt = worktrees.value.find((w) => w.path === targetDir);
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
      const title = update.title.replace(/^[\u2733\u2800-\u28FF] /, "");
      if (!title) return;
      // セッション開始・レジューム時の汎用タイトル "Claude Code" で Task を上書きしない
      if (title === "Claude Code") return;
      void drainTitleSync(dir, title);
    },
  );

  const cleanups: Array<() => void> = [];
  onMounted(() => {
    // gitStatusChange は worktree/rpc の GitStatusChangePayload で型付けるが、
    // ここでは fetchData を再発火するだけなので payload は使わない。
    cleanups.push(onMessage("gitStatusChange", () => fetchData()));
    cleanups.push(onMessage<BranchChangePayload>("branchChange", () => fetchData()));
    cleanups.push(onMessage<WorktreeChangePayload>("worktreeChange", () => fetchData()));
  });
  onUnmounted(() => {
    for (const cleanup of cleanups) cleanup();
  });

  return {
    worktrees,
    freeBranches,
    rootWorktree,
    nonMainWorktrees,
    sortedBranches,
    fetchData,
  };
}
