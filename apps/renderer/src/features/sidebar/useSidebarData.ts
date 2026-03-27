import type { Task, WorktreeEntry } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRpc } from "../../shared/rpc";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { dirName } from "./utils";

/**
 * サイドバーのデータ取得・状態管理。
 * worktrees / freeBranches / pendingTasks を一括取得し、
 * git status / worktree 変更イベントで自動リフレッシュする。
 */
export function useSidebarData() {
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const { request, onGitStatusChange, onBranchChange, onWorktreeChange } = useRpc();

  const worktrees = ref<WorktreeEntry[]>([]);
  /** worktree 化されていないローカルブランチ */
  const freeBranches = ref<string[]>([]);
  /** 未着手の Task（worktreeDir なし） */
  const pendingTasks = ref<Task[]>([]);
  /** fetchData の世代管理（並行実行で stale なレスポンスを破棄するため） */
  let fetchGen = 0;

  /** root（main）worktree */
  const rootWorktree = computed(() => worktrees.value.find((wt) => wt.isMain));

  /** main 以外の worktree をディレクトリ名のアルファベット順で */
  const nonMainWorktrees = computed(() =>
    worktrees.value
      .filter((wt) => !wt.isMain)
      .sort((a, b) => dirName(a.path).localeCompare(dirName(b.path))),
  );

  const sortedBranches = computed(() => [...freeBranches.value].sort((a, b) => a.localeCompare(b)));

  async function fetchData() {
    if (!worktreeStore.dir) return;
    const gen = ++fetchGen;
    const [wtList, branchList, taskList] = await Promise.all([
      request.gitWorktreeList(),
      request.gitBranchList(),
      request.taskList(),
    ]);
    // 並行実行された新しい fetchData が先に完了していたら、この結果は stale なので破棄
    if (gen !== fetchGen) return;
    worktrees.value = wtList;
    const wtBranches = new Set(wtList.map((wt) => wt.branch).filter(Boolean));
    freeBranches.value = branchList.filter((b) => !wtBranches.has(b));
    pendingTasks.value = taskList.filter((t) => !t.worktreeDir);

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

  async function syncTaskTitle(dir: string, title: string) {
    const wt = worktrees.value.find((w) => w.path === dir);
    if (!wt) return;
    if (!wt.task) {
      const addResult = await tryCatch(request.taskAdd({ body: title, worktreeDir: dir }));
      if (addResult.ok) {
        const freshWt = worktrees.value.find((w) => w.path === dir);
        if (freshWt) freshWt.task = addResult.value;
      }
      return;
    }
    const [firstLine, ...rest] = wt.task.body.split("\n");
    if (firstLine === title) return;
    const newBody = [title, ...rest].join("\n");
    const result = await tryCatch(request.taskUpdate({ id: wt.task.id, body: newBody }));
    if (result.ok) {
      const freshWt = worktrees.value.find((w) => w.path === dir);
      if (freshWt) freshWt.task = result.value;
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
    cleanups.push(onGitStatusChange(() => fetchData()));
    cleanups.push(onBranchChange(() => fetchData()));
    cleanups.push(onWorktreeChange(() => fetchData()));
  });
  onUnmounted(() => {
    for (const cleanup of cleanups) cleanup();
  });

  return {
    worktrees,
    freeBranches,
    pendingTasks,
    rootWorktree,
    nonMainWorktrees,
    sortedBranches,
    fetchData,
  };
}
