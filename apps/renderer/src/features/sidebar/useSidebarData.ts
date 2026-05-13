import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { useTerminalStore } from "../terminal";
import { useWorktreeStore } from "../worktree";
import {
  rpcAppStateLoad,
  rpcAppStateSave,
  rpcGitWorktreeList,
  rpcTaskAdd,
  rpcTaskUpdate,
} from "./rpc";
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

  /** 1 つの repo の worktrees を取り直して repoStore を更新 */
  async function fetchRepo(rootDir: string) {
    const repo = repoStore.repos[rootDir];
    if (repo === undefined || !repo.isGitRepo) return;
    const gen = (fetchGenByRoot.get(rootDir) ?? 0) + 1;
    fetchGenByRoot.set(rootDir, gen);

    // fetch 開始時点の per-wt gitStatuses 世代スナップショット。
    // RPC 往復中に gitStatusChange push / loadGitStatus が走って個別 wt の status を
    // 更新した場合、ここで取った世代より進んでいるので、レスポンスの古い gitStatuses を
    // 捨てて現値を保持する判断に使う。
    const gitStatusGenSnapshot = new Map<string, number>();
    for (const wt of repo.worktrees) {
      gitStatusGenSnapshot.set(wt.path, repoStore.getGitStatusGen(wt.path));
    }

    const result = await tryCatch(rpcGitWorktreeList({ dir: rootDir }));
    if (!result.ok) {
      notify.error(`Failed to fetch repo data: ${repo.repoName}`, result.error);
      return;
    }
    if (fetchGenByRoot.get(rootDir) !== gen) return;
    const wtList = result.value.worktrees;

    // 外部で削除された worktree のターミナルを cleanup（この repo の旧 worktrees に限定）
    const newPaths = new Set(wtList.map((wt) => wt.path));
    const stalePaths = repo.worktrees.map((w) => w.path).filter((p) => !newPaths.has(p));

    repoStore.updateRepoData(rootDir, wtList, gitStatusGenSnapshot);

    for (const dir of stalePaths) terminalStore.remove(dir);

    // resume バッジ用に、このプロジェクトの保存セッション数を取り直す。
    // worktree 一覧が確定した直後に走らせることで、削除済み worktree のエントリも
    // refresh で消える（store 側の事前 delete + 再カウント方式）。
    void terminalStore.refreshSavedSessionCounts(
      wtList.map((wt) => wt.path),
      rootDir,
    );
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

  // active dir 切り替え時: 所属 repo を最新化
  watch(
    () => worktreeStore.dir,
    (dir) => {
      if (dir === undefined) return;
      const owning = repoStore.findRepoOwning(dir);
      if (owning) void fetchRepo(owning.rootDir);
    },
    { immediate: true },
  );

  // wt 選択イベント（setOpen）の度に done バッジを消化する。
  // 同 dir 再選択でも selectionVersion はインクリメントされるため、サイドバー再クリック
  // やターミナル focus による同一 wt 再選択もここで一括消化される。
  // claude status の所有者は terminalStore だが、両 store 参照を持つこの場所に集約する
  // ことで、useTerminalStore → ../worktree barrel の import を増やさず cycle を避ける。
  // immediate: true は、watch 登録より先に gozdOpen 等で setOpen が呼ばれたケース
  // （hydrateFromAppState は setOpen を経由しないが、gozdOpen 経路はそうとは限らない）
  // で初回選択イベントを取りこぼさないための保険。dir が undefined なら no-op。
  watch(
    () => worktreeStore.selectionVersion,
    () => {
      const dir = worktreeStore.dir;
      if (dir === undefined) return;
      terminalStore.clearDoneStates(dir);
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
    // shared/repo は notification を直接呼べないため、auto-fallback 発火時の通知経路を
    // ここから DI する。これで外部 git worktree remove で active dir が rootDir に
    // 切り替わったケースがトーストで観察可能になる。subscription より前に置くことで、
    // 初期 fetchRepo（hydrate 経由）が万一 fallback を発火しても取りこぼさない。
    // onUnmounted で undefined に戻して旧参照を残さない（HMR / テストでの leak 防止）。
    repoStore.setAutoFallbackNotifier((message) => notify.info(message));
    cleanups.push(() => repoStore.setAutoFallbackNotifier(undefined));

    // branchChange / worktreeChange は worktree 構成自体が変わるので worktree list の
    // 全件再取得が必要。gitStatusChange は payload に dir + statuses を持ち、
    // useGitStatusSync が repoStore.setWorktreeGitStatuses で該当 wt のみ更新するため
    // ここで全件 refetch を走らせない（N 倍の git status 実行を避ける）。
    cleanups.push(onMessage<BranchChangePayload>("branchChange", () => fetchOwnerOfActive()));
    cleanups.push(onMessage<WorktreeChangePayload>("worktreeChange", () => fetchOwnerOfActive()));
    void hydrateAppState();
  });
  onUnmounted(() => {
    for (const cleanup of cleanups) cleanup();
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      // 保留中の変更を即時 flush して取りこぼしを防ぐ
      void rpcAppStateSave({ state: repoStore.buildAppStateSnapshot() });
    }
  });

  // --- 永続化（app-state.json）---
  //
  // hydrate: app-state.json を読み、repoStore に反映
  // save: dirOrder / collapsedRoots / selectedDir の変化を debounce で書き戻す

  let hydrated = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const SAVE_DEBOUNCE_MS = 300;

  async function hydrateAppState() {
    const result = await tryCatch(rpcAppStateLoad({}));
    if (result.ok && result.value.state !== undefined) {
      repoStore.hydrateFromAppState(result.value.state);
    }
    hydrated = true;
  }

  // snapshot を JSON シリアライズした文字列を watch source にする。
  // updateRepoData は `repos.value[rootDir] = { ...current, worktrees, ... }` で
  // スロット自体を差し替えるため、`repos.value[rootDir]` を読む getter は必ず
  // invalidate される。source は再実行されるが、シリアライズ結果が前と同じなら
  // Vue の値比較で callback は呼ばれず save も走らない。これにより worktrees /
  // gitStatuses / task の変化（git status push, fetchRepo, Task title sync）では
  // `app-state.json` が save されなくなる。
  watch(
    () => JSON.stringify(repoStore.buildAppStateSnapshot()),
    () => {
      if (!hydrated) return;
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        saveTimer = undefined;
        await tryCatch(rpcAppStateSave({ state: repoStore.buildAppStateSnapshot() }));
      }, SAVE_DEBOUNCE_MS);
    },
  );

  return {
    fetchRepo,
  };
}
