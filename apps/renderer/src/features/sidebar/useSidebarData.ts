import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import type { NotifyPayload } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import { useTerminalStore } from "../terminal";
import type { HookPayload } from "../terminal";
import { useWorktreeStore } from "../worktree";
import { rpcAppStateLoad, rpcAppStateSave, rpcGitWorktreeList, rpcTaskUpdate } from "./rpc";
import type { BranchChangePayload, FsWatchReadyPayload, WorktreeChangePayload } from "./rpc";
import { CLAUDE_PLACEHOLDER_TITLE } from "./utils";

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

  // --- ターミナルタイトル → 同 leaf に紐付く Task タイトル同期 ---
  //
  // 1 wt = 複数 session の前提で、leafId → ptyId → sessionId →
  // task.id の経路で対象 Task を厳密に特定する。RPC 処理中に来た更新は
  // pendingSync に退避し、完了後に再実行する。
  //
  // session 確立直後の race: session-start hook を受けた `onMessage("hook", ...)`
  // 経路で wt.tasks に楽観 push し、Swift 側 TaskStore.upsertForSession の同期
  // 完了と整合する。それでも renderer state 反映前に OSC title が到達した場合は
  // syncTaskTitle 内の 1 回 fetchRepo で再評価する。

  let titleSyncing = false;
  let pendingSync: { leafId: string; title: string } | undefined;

  async function syncTaskTitle(leafId: string, title: string) {
    const targetDir = terminalStore.getPaneDir(leafId);
    if (targetDir === undefined) return;
    const ptyId = terminalStore.getPtyId(leafId);
    if (ptyId === undefined) return;
    const sessionId = terminalStore.getSessionIdByPtyId(ptyId);
    if (sessionId === undefined) return;

    const owning = repoStore.findRepoOwning(targetDir);
    if (owning === undefined) return;
    const projectDir = owning.rootDir;
    let wt = owning.worktrees.find((w) => w.path === targetDir);
    if (wt === undefined) return;

    if (!wt.tasks.some((t) => t.id === sessionId)) {
      // session-start hook の楽観 push が反映されておらず、かつ Swift 側 TaskStore
      // への永続化と renderer state の同期が間に合っていない race。1 度だけ
      // refetch して再評価する。それでも無ければ次の OSC title でリカバリされる。
      await fetchRepo(projectDir);
      const refreshed = repoStore.repos[projectDir];
      wt = refreshed?.worktrees.find((w) => w.path === targetDir);
      if (wt === undefined) return;
      if (!wt.tasks.some((t) => t.id === sessionId)) return;
    }

    const result = await tryCatch(rpcTaskUpdate({ dir: projectDir, id: sessionId, body: title }));
    if (result.ok && result.value.task !== undefined) {
      const updatedTask = result.value.task;
      const freshRepo = repoStore.repos[projectDir];
      const freshWt = freshRepo?.worktrees.find((w) => w.path === targetDir);
      if (freshWt) {
        // 該当 id のみ差し替える。tasks 全体を上書きすると別 session の task を消す。
        freshWt.tasks = freshWt.tasks.map((t) => (t.id === updatedTask.id ? updatedTask : t));
      }
    }
  }

  async function drainTitleSync(leafId: string, title: string) {
    if (titleSyncing) {
      pendingSync = { leafId, title };
      return;
    }
    titleSyncing = true;
    try {
      await syncTaskTitle(leafId, title);
      while (pendingSync !== undefined) {
        const next = pendingSync;
        pendingSync = undefined;
        await syncTaskTitle(next.leafId, next.title);
      }
    } finally {
      titleSyncing = false;
    }
  }

  watch(
    () => terminalStore.lastTitleUpdate,
    (update) => {
      if (!update?.title) return;
      // Claude Code のステータスプレフィックス（✳ + Braille dots）を除去
      const title = update.title.replace(/^[✳⠀-⣿] /, "");
      if (!title) return;
      if (title === CLAUDE_PLACEHOLDER_TITLE) return;
      void drainTitleSync(update.leafId, title);
    },
  );

  // ターミナル close で Claude session が消えた時、所属 repo を refetch して
  // WorktreeEntry.tasks から消えた Task を反映する。terminalStore からは
  // 通知 ref のみ受け取り、repo 依存はこちら側に閉じる (循環依存防止)。
  watch(
    () => terminalStore.lastRemovedSessionInfo,
    (info) => {
      if (info === undefined) return;
      const owning = repoStore.findRepoOwning(info.dir);
      if (owning) void fetchRepo(owning.rootDir);
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
    // `useFsWatchSync` の watch 起動完了通知。往復中の取りこぼし救済として 1 回だけ
    // worktree list を取り直す。
    cleanups.push(onMessage<FsWatchReadyPayload>("fsWatchReady", () => fetchOwnerOfActive()));
    // 永続化ストア (TaskStore / ClaudeSessionStore) の失敗 notify を該当 repo の
    // 真値再取得トリガとして使う。この経路が兼用する責務は 2 つ:
    // - session hook (session-start / session-end) の楽観更新の rollback。
    //   renderer 側で wt.tasks を楽観 push / filter remove したあと、Swift 側の
    //   upsertForSession / upsert / removeBySession / removeBySessionId のいずれか
    //   が失敗した場合、refetch で真値に戻す
    // - 楽観更新を伴わない経路 (reconcileAll / removeByWorktree / removeByPty 等)
    //   の失敗時も該当 repo の真値を取り直す。永続化と renderer state が乖離
    //   する可能性がある以上、refetch で能動的に整合を取る
    // session hook 経路の I/O 失敗はディスクフル / 権限欠落 / 競合書き込みで連発
    // しうるため、N repo × hook 頻度で fetchRepo が爆発しないよう、notify payload
    // の dir から発生源 repo を特定して該当 1 repo だけ refetch する。経路に紐付か
    // ない通知 (起動時 reconcile / socket 等) は dir 空文字で届くため、その場合だけ
    // 全 repo refetch にフォールバックする。
    const ROLLBACK_SOURCES = new Set(["task-store", "claude-sessions"]);
    cleanups.push(
      onMessage<NotifyPayload>("notify", (payload) => {
        if (payload.type !== "error" || !ROLLBACK_SOURCES.has(payload.source)) return;
        if (payload.dir === "") {
          for (const rootDir of repoStore.dirOrder) void fetchRepo(rootDir);
          return;
        }
        const owning = repoStore.findRepoOwning(payload.dir);
        if (owning === undefined) return;
        void fetchRepo(owning.rootDir);
      }),
    );

    // Claude session の生成 / 終了で wt.tasks を楽観更新し UI に即時反映する。
    // Swift 側 TaskStore は applyClaudeSessionHook で session-start / session-end
    // と同期に upsertForSession / removeBySession を完了させるため、renderer 側の
    // 楽観更新と永続化は同期完結する。後追い fetchRepo は OSC title sync の
    // freshWt.tasks.map 更新を上書きする race を生むため呼ばない。真値の差し戻しは
    // 永続化失敗 notify 経路 (`ROLLBACK_SOURCES` を見る onMessage("notify") 購読)
    // と次の任意 fetch (worktreeChange / fsWatchReady / explicit refresh) に任せる。
    cleanups.push(
      onMessage<HookPayload>("hook", (payload) => {
        if (payload.event !== "session-start" && payload.event !== "session-end") return;
        if (payload.sessionId === "") {
          // Swift hook payload には sessionId が必ず入る前提 (GozdApp.swift の onHook
          // が session-start / session-end でセットする)。空文字到達は仕様外なので
          // silent 通過させず観察可能化する。
          console.warn(
            `[useSidebarData] ${payload.event} with empty sessionId (ptyId=${payload.ptyId})`,
          );
          return;
        }
        const leafId = terminalStore.getLeafIdByPtyId(payload.ptyId);
        if (leafId === undefined) return;
        const dir = terminalStore.getPaneDir(leafId);
        if (dir === undefined) return;
        const owning = repoStore.findRepoOwning(dir);
        if (owning === undefined) return;
        const wt = owning.worktrees.find((w) => w.path === dir);
        if (wt === undefined) return;
        if (payload.event === "session-start") {
          // 既存 (重複 hook / 復元レース) は無視。なければ append。
          if (!wt.tasks.some((t) => t.id === payload.sessionId)) {
            wt.tasks = [
              ...wt.tasks,
              {
                id: payload.sessionId,
                body: "",
                worktreeDir: dir,
                prNumber: 0,
                issueNumber: 0,
                createdAt: new Date().toISOString(),
              },
            ];
          }
        } else {
          wt.tasks = wt.tasks.filter((t) => t.id !== payload.sessionId);
        }
      }),
    );
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
