import type { Todo, WorktreeEntry } from "@gozd/rpc";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRpc } from "../../shared/rpc";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { dirName } from "./utils";

/**
 * サイドバーのデータ取得・状態管理。
 * worktrees / freeBranches / pendingTodos を一括取得し、
 * git status / worktree 変更イベントで自動リフレッシュする。
 */
export function useSidebarData() {
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const { request, onGitStatusChange, onWorktreeChange } = useRpc();

  const worktrees = ref<WorktreeEntry[]>([]);
  /** worktree 化されていないローカルブランチ */
  const freeBranches = ref<string[]>([]);
  /** 未着手の Todo（worktreeDir なし） */
  const pendingTodos = ref<Todo[]>([]);
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
    const [wtList, branchList, todoList] = await Promise.all([
      request.gitWorktreeList(),
      request.gitBranchList(),
      request.todoList(),
    ]);
    // 並行実行された新しい fetchData が先に完了していたら、この結果は stale なので破棄
    if (gen !== fetchGen) return;
    worktrees.value = wtList;
    const wtBranches = new Set(wtList.map((wt) => wt.branch).filter(Boolean));
    freeBranches.value = branchList.filter((b) => !wtBranches.has(b));
    pendingTodos.value = todoList.filter((t) => !t.worktreeDir);

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

  const cleanups: Array<() => void> = [];
  onMounted(() => {
    cleanups.push(onGitStatusChange(() => fetchData()));
    cleanups.push(onWorktreeChange(() => fetchData()));
  });
  onUnmounted(() => {
    for (const cleanup of cleanups) cleanup();
  });

  return {
    worktrees,
    freeBranches,
    pendingTodos,
    rootWorktree,
    nonMainWorktrees,
    sortedBranches,
    fetchData,
  };
}
