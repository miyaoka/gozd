import type { BranchChangePayload, HookPayload, WorktreeChangePayload } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { useRepoStore } from "../../shared/repo";
import { onMessage } from "../../shared/rpc";
import type { FsWatchReadyPayload } from "../../shared/rpc";
import { rpcClaudeSessionList } from "../session";
import { useTerminalStore } from "../terminal";
import { rpcGitGithubIdentity, rpcGitWorktreeList, useWorktreeStore } from "../worktree";
import { restoreActiveDir } from "./restoreActiveDir";
import { rpcAppStateLoad, rpcAppStateSave } from "./rpc";

/**
 * サイドバーのデータ取得・状態管理。
 *
 * 全 repo を per-rootDir で並列に管理する：
 * - `fetchRepo(rootDir)` を 1 単位として、新規追加 / push event / 明示リフレッシュで使い回す
 * - セッション一覧は Claude Code のセッションログが SSOT。セッションの開始 / 終了と端末の
 *   close で取り直す
 */
export function useSidebarData() {
  const worktreeStore = useWorktreeStore();
  const terminalStore = useTerminalStore();
  const repoStore = useRepoStore();
  const notify = useNotificationStore();

  /** repo ごとの fetch 世代カウンタ。並行 fetch で stale なレスポンスを破棄するため */
  const fetchGenByRoot = new Map<string, number>();
  const sessionFetchGenByRoot = new Map<string, number>();

  /** 1 つの repo のセッション一覧を取り直して repoStore を更新。git 管理外の project も対象 */
  async function fetchSessions(rootDir: string) {
    if (repoStore.repos[rootDir] === undefined) return;
    const gen = (sessionFetchGenByRoot.get(rootDir) ?? 0) + 1;
    sessionFetchGenByRoot.set(rootDir, gen);
    const result = await tryCatch(rpcClaudeSessionList({ dir: rootDir }));
    if (!result.ok) {
      notify.error(`Failed to list Claude sessions: ${rootDir}`, result.error);
      return;
    }
    if (sessionFetchGenByRoot.get(rootDir) !== gen) return;
    repoStore.setRepoSessions(rootDir, result.value.sessions);
  }

  /** 1 つの repo の worktrees とセッション一覧を取り直して repoStore を更新 */
  async function fetchRepo(rootDir: string) {
    const repo = repoStore.repos[rootDir];
    if (repo === undefined) return;
    void fetchSessions(rootDir);
    if (!repo.isGitRepo) return;
    const gen = (fetchGenByRoot.get(rootDir) ?? 0) + 1;
    fetchGenByRoot.set(rootDir, gen);

    // fetch 開始時点の per-wt head 世代スナップショット。RPC 往復中に status が head を
    // 書いていた wt は、レスポンスの（往復前に読んだ）head を捨てて現値を保持する判断に使う。
    const headGenSnapshot = new Map<string, number>();
    for (const wt of repo.worktrees) {
      headGenSnapshot.set(wt.path, repoStore.getObservationGen(wt.path).head);
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

    repoStore.updateRepoData(rootDir, wtList, headGenSnapshot);

    for (const dir of stalePaths) terminalStore.remove(dir);
  }

  /**
   * origin remote から GitHub identity (owner / repo) を解決して repoStore に書く。
   * remote URL のローカル parse (外部通信なし)。repo 追加時に 1 回だけ取得する
   * (remote URL の変更を検知する push 経路は無く、都度 refetch する価値がない)。
   *
   * 失敗 (git CLI launch 不能等のグローバル条件) はトーストしない。owner なしは
   * 「sidebar は identicon、git-graph は issue リンク無し」という定義済みの劣化に倒れる
   * progressive enhancement であり、per-repo に N 回同一トーストを出しても actionable
   * でないため、console.debug で観察可能性だけ残す。非 github.com / remote 未設定は
   * native 側が空文字に正規化して ok で返るので、そもそもここには来ない。
   *
   * githubIdentity undefined は「解決中」の契約 (RepoIcon が空プレースホルダーを出す)。
   * 非 git repo と fetch 失敗も空 identity を書いて解決済みに倒し、undefined のまま
   * 残さない (残すとプレースホルダーが永続し identicon に到達しない)。
   */
  async function fetchGithubIdentity(rootDir: string) {
    const repo = repoStore.repos[rootDir];
    if (repo === undefined) return;
    if (!repo.isGitRepo) {
      repoStore.setGithubIdentity(rootDir, { owner: "", repo: "" });
      return;
    }
    const result = await tryCatch(rpcGitGithubIdentity({ dir: rootDir }));
    if (!result.ok) {
      notify.debug(`[useSidebarData] github identity fetch failed: ${rootDir}`, result.error);
      repoStore.setGithubIdentity(rootDir, { owner: "", repo: "" });
      return;
    }
    repoStore.setGithubIdentity(rootDir, {
      owner: result.value.owner,
      repo: result.value.repo,
    });
  }

  // 新規 repo が追加されたら即 fetch。
  // repo list は表示のみの概念なので、非アクティブ repo list の repo も含むプール全体
  // (poolDirs) を watch する（アクティブ repo list だけだと hydrate 直後に非表示 repo の
  // worktrees / identity が未取得のまま残り、findRepoOwning / PTY 帰属が壊れる）。
  watch(
    () => [...repoStore.poolDirs],
    (next, prev) => {
      const prevSet = new Set(prev);
      for (const dir of next) {
        if (!prevSet.has(dir)) {
          void fetchGithubIdentity(dir);
          void fetchRepo(dir);
        }
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

  // 明示 refetch 要求: feature 層 (sidebar / picker 等) からの SSOT 取り直し signal。
  // worktree dir 切り替えに乗らない経路 (例: worktree の作成直後、セッションの名前変更) で
  // 楽観更新ではなく真値 fetch に倒すための窓口。
  watch(
    () => repoStore.refreshRequest,
    (req) => {
      if (req === undefined) return;
      void fetchRepo(req.rootDir);
    },
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

  /**
   * leafId → 直近で「session-start hook を受けた sessionId」のローカル mapping。
   * session-end 時の title クリア判定で「ending session が leaf の最新 session か」を
   * 自前で判定するために持つ。これにより `terminalStore.getSessionIdByPtyId` 経由の
   * subscription 登録順依存 (claudeStatus 側 handler が先に走って mapping を破棄して
   * いるかどうか) に頼らず、`useSidebarData` 内部だけで late session-end を判別できる。
   */
  const latestSessionByLeaf = new Map<string, string>();

  // leaf 自体が破棄されたら latestSessionByLeaf を掃除する。session-end の発火を
  // 伴わない leaf 破棄 (PTY 強制 kill 等) で entry が永続滞留して Map が肥大化する
  // のを防ぐ。terminalStore が leafId 所有者なので、削除通知シグナルを介して
  // この store ローカル mapping も追従させる。
  watch(
    () => terminalStore.lastRemovedLeafId,
    (leafId) => {
      if (leafId === undefined) return;
      latestSessionByLeaf.delete(leafId);
    },
  );

  // ターミナル close で端末との紐付けが解けたセッションを、端末の開いていないセッションとして
  // 並べ直すため、所属 repo のセッション一覧を取り直す（端末を閉じた時点がログの最終更新に
  // 最も近いため、下の先頭に来る）。terminalStore からは通知 ref のみ受け取り、repo 依存は
  // こちら側に閉じる (循環依存防止)。
  watch(
    () => terminalStore.lastRemovedSessionInfo,
    (info) => {
      if (info === undefined) return;
      const owning = repoStore.findRepoOwning(info.dir);
      if (owning) void fetchSessions(owning.rootDir);
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
    // branchChange / worktreeChange / fsWatchReady いずれも payload.dir を見て、対応する
    // repo を再 fetch する。全 worktree watch 化以降は別 worktree の push が混ざるため、
    // active 限定経路ではなく、source dir の所有 repo を引き当てる方が正確かつ無駄な
    // refetch を生まない。
    function fetchOwnerOf(dir: string) {
      const owning = repoStore.findRepoOwning(dir);
      if (owning) void fetchRepo(owning.rootDir);
    }
    cleanups.push(onMessage<BranchChangePayload>("branchChange", ({ dir }) => fetchOwnerOf(dir)));
    cleanups.push(
      onMessage<WorktreeChangePayload>("worktreeChange", ({ dir }) => fetchOwnerOf(dir)),
    );
    // `useFsWatchSync` の watch 起動完了通知。往復中の取りこぼし救済として 1 回だけ
    // worktree list を取り直す。
    cleanups.push(onMessage<FsWatchReadyPayload>("fsWatchReady", ({ dir }) => fetchOwnerOf(dir)));

    // Claude session の開始 / 終了で所属 repo のセッション一覧を取り直す。
    // 開始は `/clear` や `--resume` で入れ替わった旧セッションを端末の開いていない側へ、
    // 終了（claude を抜けて端末はシェルとして残る）はそのセッションを端末の開いていない側へ移す。
    cleanups.push(
      onMessage<HookPayload>("hook", (payload) => {
        if (payload.event !== "session-start" && payload.event !== "session-end") return;
        if (payload.sessionId === "") {
          // main 側 hook payload には sessionId が必ず入る前提 (socketMessages.ts
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
        if (payload.event === "session-start") {
          // leaf の最新 session を自前 mapping に記録。session-end 側の late 判定で使う。
          latestSessionByLeaf.set(leafId, payload.sessionId);
          void fetchSessions(owning.rootDir);
        } else {
          // late 防御: leaf の最新 session-start で記録した sessionId と
          // payload.sessionId を比較。terminalStore.getSessionIdByPtyId を使うと
          // claudeStatus 側 handler の subscription 登録順に依存して結果が変わる
          // (handler 実行前なら mapping 残存、後なら undefined) ため、自前 mapping で
          // 判定する。これで「ending session が leaf の最新 session ならクリア、
          // 既に別 session に置き換わっている late session-end なら何もしない」が
          // hook 受信順だけで決まり、外部 store の内部状態と無関係になる。
          const latestForLeaf = latestSessionByLeaf.get(leafId);
          if (latestForLeaf === payload.sessionId) {
            terminalStore.setTitle(leafId, "");
            latestSessionByLeaf.delete(leafId);
          }
          void fetchSessions(owning.rootDir);
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
      restoreActiveDir(result.value.state.activeDir);
    }
    hydrated = true;
  }

  // snapshot を JSON シリアライズした文字列を watch source にする。
  // updateRepoData は `repos.value[rootDir] = { ...current, worktrees, ... }` で
  // スロット自体を差し替えるため、`repos.value[rootDir]` を読む getter は必ず
  // invalidate される。source は再実行されるが、シリアライズ結果が前と同じなら
  // Vue の値比較で callback は呼ばれず save も走らない。これにより worktrees /
  // gitStatuses の変化（git status push, fetchRepo）では `app-state.json` が save されなくなる。
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
