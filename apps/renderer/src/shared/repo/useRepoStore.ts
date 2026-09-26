import {
  type AppState,
  type ClaudeSessionSummary,
  type RepoList,
  type UpstreamStatus,
  WorktreeEntry,
} from "@gozd/rpc";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";

/** worktree ごとの git status 由来の状態。worktree 一覧は運ばず、fs 監視の push
 * （`gitStatusChange`）と単発の `rpcGitStatus` だけが書く。`gitStatusFull` 出力の 1 セットとして
 * 原子的に書き換える */
export interface WorktreeGitState {
  /** ファイル相対パス → porcelain v2 XY コード（未変更側は "."。例: ".M", "A.", "R.", "??"） */
  gitStatuses: Record<string, string>;
  /** rename / copy エントリの 新パス → 旧パス。`gitStatuses` のキーは新パスのみ持つため、
   * 旧パス (HEAD 側の比較元) はこの map で運ぶ。rename が無ければ空。 */
  renameOldPaths: Record<string, string>;
  /** upstream（追跡リモートブランチ）に対する差分。upstream 未設定、または未観測なら不在 */
  upstream?: UpstreamStatus;
  /** 変更ファイルの最終更新時刻 (Unix 秒)。clean / stat 全失敗 / 未観測のときは 0 */
  latestMtime: number;
}

/** repoStore が保持する worktree。一覧の構造に、監視から届いた status を重ねたもの */
export type RepoWorktree = WorktreeEntry & WorktreeGitState;

/** status 未観測の worktree が持つ値。status が届くまでバッジは出ない */
function emptyGitState(): WorktreeGitState {
  return { gitStatuses: {}, renameOldPaths: {}, upstream: undefined, latestMtime: 0 };
}

/** 一覧の worktree を、status 未観測の状態で repoStore に載せる形にする */
export function toRepoWorktree(entry: WorktreeEntry): RepoWorktree {
  return { ...entry, ...emptyGitState() };
}

export interface RepoState {
  /** gozdOpen で受信した dir（git toplevel）。repos の Map キーと一致する */
  rootDir: string;
  repoName: string;
  isGitRepo: boolean;
  /** rpcGitWorktreeList の構造に status を重ねたもの */
  worktrees: RepoWorktree[];
  /**
   * origin remote から解決した GitHub identity（repo 単位、全 worktree で共通）。
   * undefined は「解決中」で transient（useSidebarData の fetch 経路が非 git repo /
   * fetch 失敗も空 identity で必ず settle させる契約。RepoIcon は undefined の間だけ
   * 空プレースホルダーを出す）。owner / repo の空文字は「解決済みで identity なし」
   * （非 github.com remote / remote 未設定 / 非 git / fetch 失敗）。
   * sidebar の org アバターと git-graph の issue リンク base URL が共有する SSOT。
   */
  githubIdentity?: { owner: string; repo: string };
}

/** repo が所有する dir 1 件。非 git project は rootDir 自身を指すため worktree を持たない */
export interface RepoDirEntry {
  dir: string;
  worktree: RepoWorktree | undefined;
}

/**
 * repo を代表する dir 群。git repo は配下の全 worktree、非 git は rootDir 自身。
 * 「repo → その repo が所有する dir 集合」の分岐ルールはここが SSOT で、
 * fs watch 対象（`collectFsWatchTargetDirs`）とダッシュボードの母集団
 * （`collectDashboardRows`）が共有する。
 *
 * dir だけでなく worktree entry も返すのは、消費者の片方が dir から worktree を
 * 引き直す必要があるため。dir だけを返すと同じ分岐が呼び出し側で再実装される。
 */
export function repoDirEntries(repo: RepoState): RepoDirEntry[] {
  if (!repo.isGitRepo) return [{ dir: repo.rootDir, worktree: undefined }];
  return repo.worktrees.map((worktree) => ({ dir: worktree.path, worktree }));
}

/**
 * `useFsWatchSync` が watch すべき dir 集合を計算する pure 関数。
 * - `useRepoStore` の computed `fsWatchTargetDirs` から呼ばれ、戻り値の `Set<string>` の
 *   `===` 比較で `watch` の再 run がトリガされる
 */
export function collectFsWatchTargetDirs(
  dirOrder: readonly string[],
  repos: Readonly<Record<string, RepoState>>,
): Set<string> {
  const dirs = new Set<string>();
  for (const rootDir of dirOrder) {
    const repo = repos[rootDir];
    if (repo === undefined) continue;
    for (const { dir } of repoDirEntries(repo)) {
      dirs.add(dir);
    }
  }
  return dirs;
}

const DEFAULT_REPO_LIST_NAME = "Default";

/** 窓口の表示名 */
const CONCIERGE_NAME = "Concierge";

function createDefaultRepoList(dirOrder: string[] = []): RepoList {
  return { id: crypto.randomUUID(), name: DEFAULT_REPO_LIST_NAME, dirOrder };
}

/**
 * window 内で同居する全 repo を保持する。
 * - `repos` は rootDir をキーに repo メタ情報 + worktrees を持つ（= repo プール）
 * - `repoLists` はプールに対する名前付きビュー（表示 repo の部分集合 + 並び順）。
 *   1 repo は複数 repo list に所属できる。**プール = 全 repo list の union** が不変条件で、
 *   どの repo list にも属さない repo（PTY だけ生きる不可視状態）を構造的に作らない。
 *   repo list は表示だけを切り替え、PTY / fs watch / fetch はプール全体で維持する
 * - `selectedDir` は UI 上で選択中の worktree path（=どこかの repo の worktrees の一員）
 *   または非 git project の rootDir
 * - 非選択 repo の PTY / Claude status は terminalStore が並列保持し続ける
 */
export const useRepoStore = defineStore("repo", () => {
  const repos = ref<Record<string, RepoState>>({});
  const initialRepoList = createDefaultRepoList();
  /** 常に 1 個以上を維持する（removeRepoList が最後の 1 個を拒否、hydrate が空を正規化） */
  const repoLists = ref<RepoList[]>([initialRepoList]);
  const activeRepoListId = ref<string>(initialRepoList.id);

  const activeRepoList = computed<RepoList>(() => {
    const found = repoLists.value.find((p) => p.id === activeRepoListId.value);
    if (found !== undefined) return found;
    // id 不整合（hydrate 前の一時状態等）は先頭に倒す。repoLists は空にならない不変条件
    const [first] = repoLists.value;
    if (first === undefined) throw new Error("[useRepoStore] repoLists must not be empty");
    return first;
  });

  /**
   * アクティブ repo list の表示順。get は repo list の dirOrder、set（drag 並び替え）は
   * アクティブ repo list の dirOrder を差し替える。従来の単一リスト時代の名前を保ち、
   * 「今サイドバーに見えている repo 列」という意味論を変えない。
   */
  const dirOrder = computed<string[]>({
    get: () => activeRepoList.value.dirOrder,
    set: (next) => {
      const targetId = activeRepoList.value.id;
      repoLists.value = repoLists.value.map((p) =>
        p.id === targetId ? { ...p, dirOrder: next } : p,
      );
    },
  });

  /**
   * repo プールの走査順（全 repo list の dirOrder を repo list 順に連結して dedup）。
   * 表示に依らない横断ロジック（fs watch / findRepoOwning / fetch トリガー等）は
   * アクティブ repo list ではなくこちらを使う。
   */
  const poolDirs = computed<string[]>(() => {
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const repoList of repoLists.value) {
      for (const dir of repoList.dirOrder) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        dirs.push(dir);
      }
    }
    return dirs;
  });
  /**
   * 明示 refetch 要求。feature 層 (sidebar / picker 等) が `requestRefresh(rootDir)`
   * を呼ぶと nonce が進み、`useSidebarData` の watch 経由で `fetchRepo(rootDir)` が
   * 走る。`gitStatusChange` 等の push に依らない経路 (例: worktree の新規作成・復活の直後)
   * で SSOT を取り直すための単一信号。楽観更新 (renderer 側で `repos[...]` を直書きして
   * race を許す経路) を避ける。store には reactivity が必要なので ref で持つ。
   */
  const refreshRequest = ref<{ rootDir: string; nonce: number }>();
  function requestRefresh(rootDir: string): void {
    refreshRequest.value = { rootDir, nonce: (refreshRequest.value?.nonce ?? 0) + 1 };
  }
  /**
   * repo（rootDir）ごとの Claude セッション一覧。SSOT は Claude Code のセッションログで、
   * ここは `rpcClaudeSessionList` の最新結果を保持するだけ（取得は feature 層が行う）。
   * 1 repo の全 worktree 分をまとめて持ち、worktree への帰属はセッションの cwd で決める。
   */
  const sessionsByRoot = ref<Record<string, ClaudeSessionSummary[]>>({});
  function setRepoSessions(rootDir: string, sessions: ClaudeSessionSummary[]): void {
    if (repoAt(rootDir) === undefined) return;
    sessionsByRoot.value[rootDir] = sessions;
  }
  /** repo（本体と全 worktree）のセッション。lastModified 降順。作業ディレクトリへの帰属は
   * 呼び出し側（`buildSessionRows`）が決める */
  function sessionsOf(rootDir: string): ClaudeSessionSummary[] {
    return sessionsByRoot.value[rootDir] ?? [];
  }
  /** sessionId からセッションを全 repo 横断で引く */
  function findSession(sessionId: string): ClaudeSessionSummary | undefined {
    for (const sessions of Object.values(sessionsByRoot.value)) {
      const found = sessions.find((s) => s.sessionId === sessionId);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  /**
   * shared 層内で `selectedDir.value =` を直書きする正当な経路は以下に限定する。
   * 新たな書き換え経路を増やす前に、`worktreeStore.setOpen` 側の副作用一覧
   * （selectionVersion bump / 必要なら selection / selectPathVersion の同期更新）と整合
   * するか確認すること（feature 層側の責務に踏み込む変更が必要な可能性）。
   * - `selectDir()`: 通常の選択（feature 層の setOpen 経由含む）
   * - `removeRepo()`: repo まるごと削除時の fallback
   * - `updateRepoData()`: 配下 wt 削除時の rootDir fallback
   */
  const selectedDir = ref<string>();
  /** 折りたたまれている repo の rootDir 集合 */
  const collapsedRoots = ref<Set<string>>(new Set());
  /**
   * サイドバーで実際に画面に写っている（展開済み + viewport 内）repo の rootDir 集合。
   * `RepoSection` が IntersectionObserver で報告し、`useRemoteFetchSync` が背景 fetch の
   * 対象スコープに使う。collapsed / scroll 外の repo を fetch しないための SSOT
   * （active repo は sync 側で別途 union に加える）。
   */
  const onScreenRoots = ref<Set<string>>(new Set());

  /** repo カードの viewport 可視状態を反映する。実変化時のみ Set を張り替え無駄発火を防ぐ */
  function setRepoOnScreen(rootDir: string, onScreen: boolean) {
    if (onScreen === onScreenRoots.value.has(rootDir)) return;
    const next = new Set(onScreenRoots.value);
    if (onScreen) next.add(rootDir);
    else next.delete(rootDir);
    onScreenRoots.value = next;
  }

  /**
   * auto-fallback 発火時の通知ハンドラ。feature 層から `setAutoFallbackNotifier()` で注入する。
   * shared 間の依存禁止 + shared → feature 依存禁止のため、`useNotificationStore` を
   * 直接呼べない。`useCommandRegistry` の `setErrorHandler` と同じ DI 流儀。
   * 未設定時は console.info にフォールバックして観察可能性を最低限担保する。
   * `undefined` を渡せばリセット（HMR / unmount で旧参照を残さないため）。
   */
  let autoFallbackNotifier: ((message: string) => void) | undefined;
  function setAutoFallbackNotifier(notifier: ((message: string) => void) | undefined): void {
    autoFallbackNotifier = notifier;
  }
  function notifyAutoFallback(message: string): void {
    if (autoFallbackNotifier !== undefined) {
      autoFallbackNotifier(message);
      return;
    }
    console.info(message);
  }

  /**
   * per-dir の書き込み世代。往復中の RPC レスポンスは開始時の世代を覚えておき、帰ってきた
   * 時点で世代が進んでいれば「より新しい観測が後勝ちで入った」と判断してその値を捨てる。
   *
   * status と head で世代を分けるのは、書き手が違うため。status は監視の push と単発の
   * `rpcGitStatus` だけが書き、head はそれに加えて worktree 一覧も書く。1 本にすると、
   * 一覧の反映が往復中の status を古いとみなして捨ててしまう。
   * reactivity 不要なため ref ではなく素の Map で持つ。
   */
  const statusGenByDir = new Map<string, number>();
  const headGenByDir = new Map<string, number>();
  function bumpGen(gens: Map<string, number>, dir: string): void {
    gens.set(dir, (gens.get(dir) ?? 0) + 1);
  }
  function getObservationGen(dir: string): { status: number; head: number } {
    return { status: statusGenByDir.get(dir) ?? 0, head: headGenByDir.get(dir) ?? 0 };
  }

  /**
   * 窓口（docs/concierge.md）。非 git の project として扱うが、repo list にもプールにも載せず、
   * 永続化もしない（窓口のディレクトリは main が決める）。dir がどの project に属するかの判定
   * （`findRepoOwning` / `selectedRepo` / ファイル監視 / セッション）ではプールの repo と同じに扱う。
   */
  const concierge = ref<RepoState>();
  function setConciergeDir(dir: string): void {
    concierge.value = {
      rootDir: dir,
      repoName: CONCIERGE_NAME,
      isGitRepo: false,
      worktrees: [],
      // 非 git なので GitHub の owner / repo は無い。解決済みの空で確定させる
      githubIdentity: { owner: "", repo: "" },
    };
  }
  /** rootDir の project。プールの repo か窓口 */
  function repoAt(rootDir: string): RepoState | undefined {
    if (rootDir === concierge.value?.rootDir) return concierge.value;
    return repos.value[rootDir];
  }
  /** dir の属する project を探す対象。窓口とプール全体 */
  const projectRepos = computed<RepoState[]>(() => {
    const pool = poolDirs.value.flatMap((rootDir) => {
      const repo = repos.value[rootDir];
      return repo === undefined ? [] : [repo];
    });
    return concierge.value === undefined ? pool : [concierge.value, ...pool];
  });
  function ownerIn(dir: string): RepoState | undefined {
    return projectRepos.value.find(
      (repo) => repo.rootDir === dir || repo.worktrees.some((wt) => wt.path === dir),
    );
  }

  /** selectedDir を含む repo を逆引き。最初に dir を含む repo。
   * active dir はどの repo list の repo でも選択できるためプール全体を走査する */
  const selectedRepo = computed(() => {
    const dir = selectedDir.value;
    if (dir === undefined) return undefined;
    // worktrees にまだ含まれていない（fetch 前）場合の fallback
    return ownerIn(dir) ?? repos.value[dir];
  });

  const selectedIsGitRepo = computed(() => selectedRepo.value?.isGitRepo ?? false);
  const selectedRootDir = computed(() => selectedRepo.value?.rootDir);

  /** `useFsWatchSync` が watch すべき dir 集合。`repos[*].worktrees` または非 git の rootDir。
   * repo list は表示のみの概念なので、非アクティブ repo list の repo も watch し続ける */
  const fsWatchTargetDirs = computed(() => {
    const dirs = collectFsWatchTargetDirs(poolDirs.value, repos.value);
    if (concierge.value !== undefined) dirs.add(concierge.value.rootDir);
    return dirs;
  });

  /** dir がどこかの repo の worktrees に含まれていればその repo を返す（窓口とプール全体） */
  function findRepoOwning(dir: string): RepoState | undefined {
    return ownerIn(dir);
  }

  /** `dir` が active repo (selectedDir 所属) と同じ repo を共有しているか。
   * 全 worktree watch 経路で受け取る push (`branchChange` / `remoteRefsChange` /
   * `fsWatchReady` 等) は **どの worktree が source か** に依らず「同 repo か」で active
   * 側の購読を絞りたい局面が多い。各 subscriber に同じ filter ロジックを書くと SSOT
   * 違反 (filter 方向のドリフト) を生むため、ここに集約する。
   * どちらかが未割当 / 所有 repo 不明な場合は false を返す。 */
  function isSameRepoAsActive(dir: string): boolean {
    const activeDir = selectedDir.value;
    if (activeDir === undefined) return false;
    const sourceRoot = findRepoOwning(dir)?.rootDir;
    const activeRoot = findRepoOwning(activeDir)?.rootDir;
    if (sourceRoot === undefined || activeRoot === undefined) return false;
    return sourceRoot === activeRoot;
  }

  /** 新規 repo を追加してアクティブ repo list に載せる。既存ならメタ情報を上書き */
  function addRepo(state: RepoState) {
    repos.value[state.rootDir] = state;
    ensureInActiveRepoList(state.rootDir);
  }

  /**
   * repo をアクティブ repo list の末尾に追加する（既に含まれていれば no-op）。
   * `gozd <path>` で既存プール repo を開いたとき、今見ているリストに必ず現れることを
   * 保証する経路。プールに未登録の rootDir を渡してはいけない（union 不変条件）。
   */
  function ensureInActiveRepoList(rootDir: string) {
    if (repos.value[rootDir] === undefined) {
      throw new Error(`[useRepoStore] ensureInActiveRepoList: ${rootDir} is not in the repo pool`);
    }
    const target = activeRepoList.value;
    if (target.dirOrder.includes(rootDir)) return;
    repoLists.value = repoLists.value.map((p) =>
      p.id === target.id ? { ...p, dirOrder: [...p.dirOrder, rootDir] } : p,
    );
  }

  /** rootDir を含む repo list の一覧。編集モードの ✕ が「repo list から外すだけ」か
   * 「window から解除（PTY cleanup 必要）」かを feature 層が判定するのに使う */
  function repoListsContaining(rootDir: string): RepoList[] {
    return repoLists.value.filter((p) => p.dirOrder.includes(rootDir));
  }

  /**
   * アクティブ repo list から repo を外す（プールからは消さない）。
   * union 不変条件の維持は呼び出し側の責務: 最後の所属 repo list から外す場合は
   * こちらではなく `removeRepo`（+ feature 層の PTY cleanup）を使うこと。
   */
  function removeFromActiveRepoList(rootDir: string) {
    const targetId = activeRepoList.value.id;
    repoLists.value = repoLists.value.map((p) =>
      p.id === targetId ? { ...p, dirOrder: p.dirOrder.filter((d) => d !== rootDir) } : p,
    );
  }

  /** repo list を追加してアクティブに切り替える。作成直後は空リストで、編集モードの
   * 「Add from other lists」からプール repo を載せる想定 */
  function addRepoList(name: string): string {
    const repoList: RepoList = { id: crypto.randomUUID(), name, dirOrder: [] };
    repoLists.value = [...repoLists.value, repoList];
    activeRepoListId.value = repoList.id;
    return repoList.id;
  }

  function renameRepoList(id: string, name: string) {
    if (name === "") return;
    repoLists.value = repoLists.value.map((p) => (p.id === id ? { ...p, name } : p));
  }

  /**
   * repo list を削除する。最後の 1 個は削除できない（no-op）。
   * union 不変条件のため、削除 repo list にしか属さない repo は先頭の残存 repo list の
   * 末尾へ移す（非破壊。window からの解除 = PTY cleanup は伴わない）。
   */
  function removeRepoList(id: string) {
    if (repoLists.value.length <= 1) return;
    const removed = repoLists.value.find((p) => p.id === id);
    if (removed === undefined) return;
    const remaining = repoLists.value.filter((p) => p.id !== id);
    const [first, ...rest] = remaining;
    if (first === undefined) return;
    const remainingUnion = new Set(remaining.flatMap((p) => p.dirOrder));
    const orphans = removed.dirOrder.filter((d) => !remainingUnion.has(d));
    repoLists.value = [{ ...first, dirOrder: [...first.dirOrder, ...orphans] }, ...rest];
    if (activeRepoListId.value === id) activeRepoListId.value = first.id;
  }

  function setActiveRepoList(id: string) {
    if (!repoLists.value.some((p) => p.id === id)) return;
    activeRepoListId.value = id;
  }

  /**
   * rootDir を含む先頭 repo list をアクティブにする（アクティブ list が既に含むなら no-op）。
   * 「アクティブ list に無い repo が選択されたら、含む list（複数所属なら repoLists 先頭側）へ
   * 表示を追従させる」選定ポリシーの SSOT。選択追従（SidebarPane の watcher）と removeRepo の
   * 選択フォールバックが共有する。プール外の rootDir はどの list にも含まれないため no-op。
   */
  function activateRepoListContaining(rootDir: string) {
    if (dirOrder.value.includes(rootDir)) return;
    const [owningList] = repoListsContaining(rootDir);
    if (owningList !== undefined) activeRepoListId.value = owningList.id;
  }

  /**
   * 既存 repo の worktrees を更新（rpcGitWorktreeList 結果の反映）。
   *
   * 一覧は構造だけを運ぶため、status は同じ path の worktree が持っていた値を引き継ぐ。
   * 新しく現れた worktree は status 未観測で始まり、監視の push が届いた時点で埋まる。
   *
   * `headGenSnapshot` には fetch 開始時に各 wt について `getObservationGen` で取った head の
   * 世代を渡す。往復中に status が head を書いていた wt は、一覧の head（往復前に読んだ OID）を
   * 採用すると巻き戻るため、現値を保持する。
   * 渡されなかった場合は一覧の head をそのまま使う（hydrate / 初回登録など世代が無意味な経路）。
   */
  function updateRepoData(
    rootDir: string,
    worktrees: WorktreeEntry[],
    headGenSnapshot?: Map<string, number>,
  ) {
    const current = repos.value[rootDir];
    if (current === undefined) return;
    const merged = worktrees.map((wt): RepoWorktree => {
      const prior = current.worktrees.find((w) => w.path === wt.path);
      const gitState: WorktreeGitState =
        prior === undefined
          ? emptyGitState()
          : {
              gitStatuses: prior.gitStatuses,
              renameOldPaths: prior.renameOldPaths,
              upstream: prior.upstream,
              latestMtime: prior.latestMtime,
            };
      const headObservedDuringFetch =
        headGenSnapshot !== undefined &&
        prior !== undefined &&
        headGenSnapshot.get(wt.path) !== (headGenByDir.get(wt.path) ?? 0);
      return { ...wt, ...gitState, head: headObservedDuringFetch ? prior.head : wt.head };
    });
    if (headGenSnapshot !== undefined) {
      // 一覧の head を書いた wt の世代を進める。fetch 開始前から往復中だった loadGitStatus が
      // 後着したとき、その head（一覧より古い観測かもしれない）で巻き戻さないため
      for (const wt of merged) bumpGen(headGenByDir, wt.path);
    }
    // selectedDir がこの repo に属していた（current.worktrees に含まれていた）かつ
    // 更新後の worktrees から消えている場合のみ、同 repo の rootDir に倒す。これがないと
    // FilerPane / useFsWatchSync / useGitStatusSync が削除済みパスに対して
    // fs/readDir, fs/watch, git/status を投げ続け outsideDir / launchFailed エラーが出る。
    // `current.worktrees` には rpcGitWorktreeList の仕様により main rootDir 自身も含まれる
    // ため、selectedDir === rootDir のケースも自然に「属していた」と扱われる（rootDir が
    // worktree list に残り続ける限り fallback は no-op）。
    // 別 repo に属する dir が active な場合は `some` が false になるため巻き込まれない。
    //
    // path 比較は文字列完全一致で正しい。invariant: `wt.path` も `selectedDir` も
    // どちらも `git worktree list --porcelain` および `git rev-parse --show-toplevel`
    // の出力をそのまま使う。git は記録された原文の絶対パスを返すだけで symlink 解決は
    // しないが、両者とも同じ git 出力経路を踏むため文字列フォーマットは揃う（trailing
    // slash なし、git が記録した形式そのまま）。ユーザーが symlink パスで起動した場合
    // も両者が symlink を含む同一形式で一致する。
    // 新しい dir 取得経路を追加する際は必ず同じ git 出力経路を踏ませること。
    // 別形式（realpath 解決後など）を混ぜると比較が空振りして fallback が発火しなくなる。
    const orphanedActiveDir =
      selectedDir.value !== undefined &&
      current.worktrees.some((w) => w.path === selectedDir.value) &&
      !merged.some((w) => w.path === selectedDir.value);
    repos.value[rootDir] = { ...current, worktrees: merged };
    if (orphanedActiveDir) {
      // 外部 git worktree remove 経由だとユーザー操作なしに active dir が切り替わる。
      // feature 層が DI した notifier 経由でユーザーに通知する。未注入なら console.info。
      // 複数 repo 同時開き時にどの repo の root に切り替わったか分かるよう repoName を含める。
      // クォートを使うと repoName 内のクォート文字でメッセージが崩れるため使わない。
      // 空文字列は hydrate 経路で混入し得るので汎用ラベルにフォールバックする。
      const repoLabel = current.repoName !== "" ? current.repoName : "the repo";
      notifyAutoFallback(`Active worktree was removed; switched to ${repoLabel} root.`);
      selectedDir.value = rootDir;
    }
  }

  interface WorktreeStatusPatch {
    statuses: Record<string, string>;
    /** rename / copy エントリの 新パス → 旧パス。`statuses` と原子的に同一 patch で書く契約 (SSOT)。 */
    renameOldPaths: Record<string, string>;
    /** upstream 未設定なら undefined。`hasUpstream` のような boolean を併持しない */
    upstream: UpstreamStatus | undefined;
    /** 変更ファイルの mtime 最大値 (Unix 秒)。clean / 未取得時は 0。
     * `statuses` / `upstream` と原子的に同一 patch で書く契約 (SSOT)。 */
    latestMtime: number;
    /** HEAD が指す commit OID。契約は `WorktreeEntry.head` を参照。
     * undefined は「この観測の head は採用しない」（往復中に新しい head が書かれた場合） */
    head: string | undefined;
  }

  /**
   * 任意 dir に対応する worktree の gitStatuses + upstream 情報をピンポイント更新する。
   * gitStatusChange push / 単発の rpcGitStatus 結果を反映する経路で使用。
   * dir に該当する worktree が見つからなければ no-op。
   * 書き込み毎に status の世代（head を書くなら head の世代も）を進め、in-flight な
   * loadGitStatus / fetchRepo の古いレスポンスがこの値を上書きできないようにする。
   *
   * **不変条件**: 呼び出しごとに `worktree` と上位 `repo` を新規オブジェクトに置き換える
   * （shallow copy）。`useGitStatusStore.gitStatuses` computed の reference 同一性を変化させ、
   * FilerPane の `watch(gitStatuses)` を確実に発火させるための SSOT。「同じ statuses なら
   * no-op で skip する」最適化を入れる場合は、watch 側を reference ベースから書き込み
   * version ref ベースに切り替える必要がある。
   */
  function setWorktreeGitStatuses(dir: string, patch: WorktreeStatusPatch) {
    const repo = findRepoOwning(dir);
    // 書き戻し先はプールの repo だけ。窓口は repos に持たない
    if (repo === undefined || repos.value[repo.rootDir] === undefined) return;
    const idx = repo.worktrees.findIndex((wt) => wt.path === dir);
    if (idx < 0) return;
    bumpGen(statusGenByDir, dir);
    if (patch.head !== undefined) bumpGen(headGenByDir, dir);
    const next = [...repo.worktrees];
    next[idx] = {
      ...next[idx],
      gitStatuses: patch.statuses,
      renameOldPaths: patch.renameOldPaths,
      upstream: patch.upstream,
      latestMtime: patch.latestMtime,
      head: patch.head ?? next[idx].head,
    };
    repos.value[repo.rootDir] = { ...repo, worktrees: next };
  }

  /**
   * 新規作成した worktree を repo の worktrees に追加。
   * 同一 path が既に存在する場合は no-op（store の最終防衛線として idempotent にする）。
   */
  function appendWorktree(rootDir: string, wt: WorktreeEntry) {
    const current = repos.value[rootDir];
    if (current === undefined) return;
    if (current.worktrees.some((w) => w.path === wt.path)) return;
    updateRepoData(rootDir, [...current.worktrees, wt]);
  }

  /**
   * origin remote から解決した GitHub identity を反映する（useSidebarData の fetch 経路が
   * 唯一の書き込み元）。repo 未登録なら no-op。
   */
  function setGithubIdentity(rootDir: string, identity: { owner: string; repo: string }) {
    const current = repos.value[rootDir];
    if (current === undefined) return;
    repos.value[rootDir] = { ...current, githubIdentity: identity };
  }

  function selectDir(dir: string) {
    selectedDir.value = dir;
  }

  /** repo を window から解除する（全 repo list + プールから除去）。
   * PTY / terminal state の cleanup は feature 層（SidebarPane）が事前に行う契約 */
  function removeRepo(rootDir: string) {
    const removed = repos.value[rootDir];
    delete repos.value[rootDir];
    repoLists.value = repoLists.value.map((p) => ({
      ...p,
      dirOrder: p.dirOrder.filter((d) => d !== rootDir),
    }));
    if (collapsedRoots.value.has(rootDir)) {
      const next = new Set(collapsedRoots.value);
      next.delete(rootDir);
      collapsedRoots.value = next;
    }
    // 配下 wt と rootDir 自身の世代エントリを掃除（追加削除の繰り返しでメモリが膨らまないように）
    if (removed !== undefined) {
      for (const dir of [removed.rootDir, ...removed.worktrees.map((wt) => wt.path)]) {
        statusGenByDir.delete(dir);
        headGenByDir.delete(dir);
      }
    }
    delete sessionsByRoot.value[rootDir];
    if (selectedDir.value !== undefined) {
      const stillOwned = findRepoOwning(selectedDir.value);
      if (stillOwned === undefined) {
        // まずアクティブ repo list の先頭、そこが空ならプール先頭（他 repo list）に倒す
        const [firstRoot = poolDirs.value[0]] = dirOrder.value;
        selectedDir.value = firstRoot;
        // プール先頭へ倒れた（= アクティブ list に無い repo を選択した）場合は、その repo を
        // 含む list へアクティブも切り替える。切り替えないと「サイドバーは empty state なのに
        // terminal / filer は別 list の repo を開いている」という表示のずれが残る
        if (firstRoot !== undefined) activateRepoListContaining(firstRoot);
      }
    }
  }

  function isCollapsed(rootDir: string): boolean {
    return collapsedRoots.value.has(rootDir);
  }

  function toggleCollapsed(rootDir: string) {
    const next = new Set(collapsedRoots.value);
    if (next.has(rootDir)) next.delete(rootDir);
    else next.add(rootDir);
    collapsedRoots.value = next;
  }

  /**
   * 折りたたみを開く（冪等）。アクティブ worktree 切り替え時に、その wt が属する repo が
   * 畳まれていても WtCard を可視化してスクロール先を作るために使う。toggle と分離するのは
   * 「既に開いている repo を閉じてしまう」副作用を構造的に排除するため（呼び出し側の意図は
   * 常に "開く" であって "トグル" ではない）。
   */
  function expand(rootDir: string) {
    if (!collapsedRoots.value.has(rootDir)) return;
    const next = new Set(collapsedRoots.value);
    next.delete(rootDir);
    collapsedRoots.value = next;
  }

  // --- 永続化サポート（I/O は feature 側で実施） ---

  /**
   * AppState の sidebar 関連フィールドを現在の store の状態で組み立てて返す。
   * shared スコープの制約により RPC 呼び出しは feature 側で行うので、
   * snapshot 構築だけここで提供する。
   */
  function buildAppStateSnapshot(): AppState {
    return {
      sidebarRepos: poolDirs.value.map((rootDir) => {
        const r = repos.value[rootDir];
        return {
          rootDir,
          repoName: r?.repoName ?? "",
          isGitRepo: r?.isGitRepo ?? false,
          collapsed: collapsedRoots.value.has(rootDir),
          // worktree キャッシュ: 起動直後の楽観カード描画に必要な最小サブセットだけ
          // 射影する。git status / upstream を含めないことで、gitStatusChange
          // push のたびに snapshot が変化して save watch が回るのを防ぐ
          // （既存 debounce 相乗り + 射影限定）。SSOT は git。
          worktrees: (r?.worktrees ?? []).map((wt) => ({
            path: wt.path,
            branch: wt.branch,
            isMain: wt.isMain,
          })),
        };
      }),
      repoLists: repoLists.value.map((p) => ({
        id: p.id,
        name: p.name,
        dirOrder: [...p.dirOrder],
      })),
      activeRepoListId: activeRepoListId.value,
      // 次回起動時の active worktree 復元用。未選択（undefined）は JSON.stringify で
      // キーごと落ちるため、save 側の shallow merge で stale な値が残らない
      activeDir: selectedDir.value,
    };
  }

  /**
   * 起動時に 1 回呼ぶ。`app-state.json` から読んだ AppState を渡すと、
   * sidebar repos / repoLists / collapsed を復元する。既に gozdOpen で追加済みの
   * repo は新規エントリとして保持する（先勝ち merge）。
   *
   * repo list の不整合はここで正規化する（マイグレーションではなく不変条件の enforce）:
   * - repoLists が空（repo list 導入前のファイル / 初回起動）→ 全プール repo を含む
   *   Default 1 個を生成
   * - dirOrder 内のプール外 dir / 重複 dir → 除去
   * - どの repo list にも属さないプール repo → 先頭 repo list の末尾へ（union 不変条件）
   * - activeRepoListId が迷子 → 先頭 repo list
   *
   * worktrees はキャッシュ（path/branch/isMain のみ）から実カードとして復元し、
   * 起動直後の layout shift を消す。git status / upstream は欠けた状態で描画され、
   * 監視の push が届いたら同一 path のカードが key 維持で in-place 更新される（楽観描画）。
   * SSOT は git。
   */
  function hydrateFromAppState(state: AppState) {
    const nextRepos: Record<string, RepoState> = {};
    const poolOrder: string[] = [];
    const nextCollapsed = new Set<string>();
    for (const r of state.sidebarRepos) {
      if (r.rootDir === "") continue;
      nextRepos[r.rootDir] = {
        rootDir: r.rootDir,
        repoName: r.repoName,
        isGitRepo: r.isGitRepo,
        // キャッシュに無い残りフィールドは空で埋め、rpcGitWorktreeList の真値で上書きされる。
        // hydrate 前に登録済みの worktree は、キャッシュより新しい観測（status を含む）を持つので
        // そのまま使う。空で置き換えると、監視は登録済みのため status が届き直さない
        worktrees: r.worktrees.map(
          (wt) =>
            repos.value[r.rootDir]?.worktrees.find((current) => current.path === wt.path) ??
            toRepoWorktree({
              path: wt.path,
              branch: wt.branch,
              isMain: wt.isMain,
              head: "",
            }),
        ),
        // githubIdentity は persist しない派生値（origin remote から都度解決）。
        // hydrate 前に gozdOpen → fetch 済みの repo は poolDirs が変わらず useSidebarData の
        // 新規 dir watch が再発火しないため、ここで引き継がないと再取得されない。
        githubIdentity: repos.value[r.rootDir]?.githubIdentity,
      };
      poolOrder.push(r.rootDir);
      if (r.collapsed) nextCollapsed.add(r.rootDir);
    }
    // hydrate 前に gozdOpen で追加された repo をプールに merge
    for (const dir of poolDirs.value) {
      if (!(dir in nextRepos) && repos.value[dir]) {
        nextRepos[dir] = repos.value[dir];
        poolOrder.push(dir);
      }
    }
    // repo list の正規化: プール外 dir / repo list 内重複を除去。id 欠落（手編集ファイル）は
    // 新規採番して repo list 自体は保持する
    const sanitized = state.repoLists.map((p): RepoList => {
      const seen = new Set<string>();
      const cleanOrder = p.dirOrder.filter((d) => {
        if (!(d in nextRepos) || seen.has(d)) return false;
        seen.add(d);
        return true;
      });
      return { id: p.id !== "" ? p.id : crypto.randomUUID(), name: p.name, dirOrder: cleanOrder };
    });
    const nextRepoLists = sanitized.length > 0 ? sanitized : [createDefaultRepoList([])];
    // union 不変条件: どの repo list にも属さないプール repo（repo list 導入前のファイル /
    // hydrate 前 merge 分）は先頭 repo list の末尾へ追加する
    const union = new Set(nextRepoLists.flatMap((p) => p.dirOrder));
    const unlisted = poolOrder.filter((d) => !union.has(d));
    const [firstRepoList, ...restRepoLists] = nextRepoLists;
    if (firstRepoList === undefined) throw new Error("[useRepoStore] repoLists must not be empty");
    repos.value = nextRepos;
    repoLists.value = [
      { ...firstRepoList, dirOrder: [...firstRepoList.dirOrder, ...unlisted] },
      ...restRepoLists,
    ];
    activeRepoListId.value = nextRepoLists.some((p) => p.id === state.activeRepoListId)
      ? state.activeRepoListId
      : firstRepoList.id;
    collapsedRoots.value = nextCollapsed;
  }

  return {
    repos,
    dirOrder,
    poolDirs,
    repoLists,
    activeRepoListId,
    activeRepoList,
    ensureInActiveRepoList,
    repoListsContaining,
    removeFromActiveRepoList,
    addRepoList,
    renameRepoList,
    removeRepoList,
    setActiveRepoList,
    activateRepoListContaining,
    selectedDir,
    selectedRepo,
    selectedIsGitRepo,
    selectedRootDir,
    fsWatchTargetDirs,
    collapsedRoots,
    onScreenRoots,
    setRepoOnScreen,
    findRepoOwning,
    isSameRepoAsActive,
    addRepo,
    concierge,
    setConciergeDir,
    repoAt,
    updateRepoData,
    setRepoSessions,
    sessionsOf,
    findSession,
    setWorktreeGitStatuses,
    setGithubIdentity,
    getObservationGen,
    appendWorktree,
    selectDir,
    removeRepo,
    isCollapsed,
    toggleCollapsed,
    expand,
    buildAppStateSnapshot,
    hydrateFromAppState,
    setAutoFallbackNotifier,
    refreshRequest,
    requestRefresh,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRepoStore, import.meta.hot));
}
