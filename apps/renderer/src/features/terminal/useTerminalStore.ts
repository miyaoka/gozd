import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { useContextKeys } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import type { ClaudeStatus } from "./claudeStatus";
import { isHookEvent, createClaudeStatusManager } from "./claudeStatus";
import { createPtySessionManager } from "./ptySession";
import type { PaneEntry } from "./ptySession";
import type { HookPayload, PtyExitPayload, PtyTextPayload } from "./rpc";
import {
  rpcClaudeSessionListByDir,
  rpcClaudeSessionListByProject,
  rpcClaudeSessionRemoveByPty,
  rpcPtyKill,
  rpcPtySpawn,
} from "./rpc";
import { createTerminalLayout } from "./terminalLayout";
import type { TerminalLayoutState } from "./terminalLayout";

// PTY spawn のデフォルト設定。ZDOTDIR 等の Claude hooks 連携は Phase 3 後半で追加する。
function getDefaultSpawnEnv(): Record<string, string> {
  return {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "en_US.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };
}
const DEFAULT_SHELL = "/bin/zsh";
const DEFAULT_SHELL_ARGS = ["/bin/zsh", "-i"];

/**
 * ターミナル分割レイアウトと PTY の状態を管理する。
 * leaf の追加・削除は store の action のみが行う（単一所有者）。
 * PTY のライフサイクル（spawn/kill/data）も store が一元管理する。
 * コンポーネントは xterm の attach/detach のみ担当する。
 */
export const useTerminalStore = defineStore("terminal", () => {
  const contextKeys = useContextKeys();
  const notify = useNotificationStore();

  // --- 共有 state ---

  /** 訪問済みの worktree ディレクトリ一覧（初回訪問順） */
  const visitedDirs = ref<string[]>([]);

  /** worktree dir → 分割レイアウト状態 */
  const layoutsByDir = ref<Record<string, TerminalLayoutState>>({});

  /**
   * 直近のターミナル close で削除された Claude session の通知。
   * sessionId が空文字なら session を持たない pane の close。
   * useSidebarData がこれを watch して所属 repo を refetch し、
   * WorktreeEntry.tasks から消えた Task を反映する。
   */
  const lastRemovedSessionInfo = shallowRef<{ dir: string; sessionId: string }>();

  /** leafId → PTY 対応 + 所属 dir */
  const paneRegistry = ref<Record<string, PaneEntry>>({});

  /** split ドラッグ中の fit 抑制カウンター */
  const dragSuspendCount = ref(0);

  /** ターミナル表示モード: wt=アクティブworktreeのみ, claude=Claude起動中のみ */
  type ViewMode = "wt" | "claude";
  /**
   * ユーザーが選択した表示モード（永続意図）。SSOT。
   * 表示側は `viewMode`（実効値）を読む。`viewMode = "wt"` などの直接代入は
   * computed の setter 経由でこの ref に転送される。
   */
  const userViewMode = ref<ViewMode>("wt");

  /** ptyId → Claude Code の状態（idle は undefined = エントリなし） */
  const claudeStatusByPtyId = ref<Record<number, ClaudeStatus>>({});

  /** leafId → PTY の現在の CWD（OSC 7 で更新される） */
  const cwdByLeafId = ref<Record<string, string>>({});

  /** leafId → ターミナルタイトル（OSC 0/2 で更新される） */
  const titleByLeafId = ref<Record<string, string>>({});

  /** 直近のタイトル更新（外部の watch 用シグナル） */
  const lastTitleUpdate = shallowRef<{ leafId: string; title: string }>();

  /**
   * 直近に破棄された leafId の通知シグナル。leaf を所有しているのは terminalStore
   * (paneRegistry / layoutsByDir) なので、外部 (useSidebarData の latestSessionByLeaf
   * 等) で leafId をキーに状態を持つ場所が cleanup できるよう、unregisterPane が
   * 呼ばれた leafId をここに乗せる。watch する側は同 leafId に紐付くローカル state を
   * 削除する。
   */
  const lastRemovedLeafId = shallowRef<string>();

  /**
   * leafId → 次回 spawn 時に env として注入する Claude session ID。
   * worktree の初回 visit 時に保存済みセッションを復元するために、leafId と sessionId を
   * 紐付けておく。spawnPty が env を組み立てるタイミングで一度だけ消費する。
   */
  const pendingResumeByLeafId = ref<Record<string, string>>({});

  /**
   * 未訪問 worktree に対する「visit で最初の leaf に乗せたい sessionId」のヒント。
   * サイドバーで resumable な Task 行をクリックしたとき、setOpen 起点の自動 visit が
   * fetched.sessions の先頭順で leaf を割り当てて意図がずれるのを防ぐ。visit 内で
   * 1 回だけ消費し、対象 dir の前置きとして使う。
   */
  const preferredResumeByDir = ref<Record<string, string>>({});

  /**
   * leafId → 次回 spawn 時に GOZD_AUTOSTART_CLAUDE フラグを立てる印。
   * session 未紐付け task (PR/issue 経由で worktree のみ作成された等) をクリック
   * した時に、resume ではなく素の `claude` を起動するために使う。spawnPty が env
   * を組み立てるタイミングで一度だけ消費する。
   */
  const pendingAutostartByLeafId = ref<Record<string, true>>({});

  /**
   * 未訪問 worktree に対する「visit で最初の leaf に autostart フラグを乗せる」ヒント。
   * preferredResumeByDir と排他的に使う。visit 内で 1 回だけ消費する。
   */
  const preferredAutostartByDir = ref<Record<string, true>>({});

  /**
   * worktreePath → 永続化済み Claude セッション数。サイドバーの resume バッジ表示用。
   * 「resume 可能 = 永続化されているがまだ live PTY に接続されていない」分は
   * `getResumeableSessionCount(dir)` で saved - live を取って算出する。
   */
  const savedSessionCountByDir = ref<Record<string, number>>({});

  /**
   * `refreshSavedSessionCounts` の世代カウンタ（per project anchor）。
   * await を跨いで stale な fetch 結果が新しい state を上書きしないよう、
   * 完了時に最新世代と一致するかチェックして書き込む。
   */
  const refreshGenByAnchor = new Map<string, number>();

  /**
   * `visit()` の世代カウンタ（per dir）。await 中に同じ dir が再 visit されたり、
   * 別の visit が並走したりしたとき、stale な復元処理が後勝ちでレイアウトを
   * 壊さないよう、await 後に最新世代と一致するかチェックする。
   */
  const visitGenByDir = new Map<string, number>();

  // --- モジュール初期化 ---

  const ptySession = createPtySessionManager({
    panes: {
      getPane: (leafId) => paneRegistry.value[leafId],
      setSession: (leafId, session) => {
        const entry = paneRegistry.value[leafId];
        if (entry === undefined) return;
        paneRegistry.value[leafId] = { ...entry, session };
      },
      iterateEntries: () => Object.entries(paneRegistry.value),
    },
    requestPtySpawn: async ({ leafId, dir, cols, rows }) => {
      const env = getDefaultSpawnEnv();
      // 復元対象セッションがあれば env に乗せる。spawn 失敗で resume ID が
      // 永久消失しないよう、map からの削除は spawn 成功後にのみ行う。
      // zsh init が GOZD_RESUME_CLAUDE_SESSION を見て `claude --resume <id>` を起動する。
      const resumeId = pendingResumeByLeafId.value[leafId];
      if (resumeId !== undefined) {
        env.GOZD_RESUME_CLAUDE_SESSION = resumeId;
      }
      const autostart = pendingAutostartByLeafId.value[leafId];
      if (autostart) {
        env.GOZD_AUTOSTART_CLAUDE = "1";
      }
      const res = await rpcPtySpawn({
        dir,
        executable: DEFAULT_SHELL,
        args: DEFAULT_SHELL_ARGS,
        env,
        rows,
        cols,
        worktreePath: dir,
      });
      if (resumeId !== undefined) {
        delete pendingResumeByLeafId.value[leafId];
      }
      if (autostart) {
        delete pendingAutostartByLeafId.value[leafId];
      }
      return res.ptyId;
    },
    sendPtyKill: ({ id }) => {
      void rpcPtyKill({ ptyId: id });
    },
    onDataReceived: (ptyId, data) => claude.detectInterrupt(ptyId, data),
    onPtyCleanup: (ptyId) => claude.cleanupPty(ptyId),
  });

  const claude = createClaudeStatusManager({
    claudeStatusByPtyId,
    panes: {
      getSessionPtyId: (leafId) => paneRegistry.value[leafId]?.session?.ptyId,
      iteratePanes: function* () {
        for (const [leafId, entry] of Object.entries(paneRegistry.value)) {
          yield { leafId, dir: entry.dir, ptyId: entry.session?.ptyId };
        }
      },
    },
    isPtyAlive: ptySession.isPtyAlive,
  });

  const layout = createTerminalLayout({
    layoutsByDir,
    visitedDirs,
    panes: {
      registerPane: (leafId, dir) => {
        paneRegistry.value[leafId] = { dir };
      },
      unregisterPane: (leafId) => {
        // resume 永続化はユーザーの明示的な pane 削除（terminal.closePane /
        // resetLayout / worktree 削除を経由する全ケース。後者には sidebar 経由の
        // 削除 / fetchRepo が stale 検知で発火する終端も含む）でのみ消す。
        // アプリ終了時は renderer ごと死ぬためこの経路を通らず、claude-sessions.json
        // はそのまま残り次回 resume できる。
        // ptyId は paneRegistry が保持しているので hook 到達順に依存せず確実に渡せる。
        const entry = paneRegistry.value[leafId];
        const ptyId = entry?.session?.ptyId;
        const dir = entry?.dir;
        if (ptyId !== undefined && dir !== undefined) {
          // 削除 RPC を先行させ、await してから killPty を呼ぶ。
          // killPty を先に投げると native の consumers task が `remove(id:)` で
          // sessionIdById を消した後に削除 RPC が到達して sessionId nil ですり抜け、
          // claude-sessions.json にエントリが残る race の窓が空く。
          // killPty / state 削除も IIFE 内に置く: ptySession.killPty(leafId) は
          // 内部で paneRegistry[leafId].session を引くため、await 前に paneRegistry
          // を消してしまうと no-op になり PTY に SIGHUP が飛ばなくなる。
          //
          // 暗黙契約（この Claude あり経路に限定）: unregisterPane return 後も
          // paneRegistry[leafId] は IIFE 完了まで残る。この間 getLeafIdsByDir
          // などの paneRegistry を走査する API は旧 leaf を返しうる。layoutsByDir
          // は呼び出し元（closePane / resetLayout / remove）でいずれも leaf 単位
          // 削除 / 全置換 / dir 削除のどれかで即時に更新済みなので、layout 経由の
          // フォーカス遷移や render には影響しない。paneRegistry を直接走査する
          // 新規呼び出し元を増やすときは、この一時併存に注意する。
          // 素 PTY pane（else 経路）はこの併存は起きない。
          void (async () => {
            const res = await tryCatch(rpcClaudeSessionRemoveByPty({ ptyId, worktreePath: dir }));
            if (!res.ok) {
              notify.error("Failed to remove saved Claude session", res.error);
            } else {
              // 削除成功後に badge を即時更新する。fetchRepo 起点の再カウントを
              // 待つと、次のサイドバー操作まで古い値が出続けるため。dir はプロジェクト
              // 内の任意 dir として projectKey 解決に使える。
              await refreshSavedSessionCounts([dir], dir);
              // session = Task の同一視: Swift 側で TaskStore から
              // 削除済み。useSidebarData がこの ref を watch して所属 repo を
              // refetch することで WorktreeEntry.tasks から消えた Task を反映する。
              // terminalStore は repoStore に依存させない (Pinia setup での循環を避ける)。
              lastRemovedSessionInfo.value = {
                dir,
                sessionId: res.value.removedSessionId,
              };
            }
            // 削除 RPC の完了後に kill。失敗時も pane の UI は閉じる契約なので
            // kill は実行する。paneRegistry にまだ entry があるので killPty は有効。
            ptySession.killPty(leafId);
            delete cwdByLeafId.value[leafId];
            delete titleByLeafId.value[leafId];
            delete pendingResumeByLeafId.value[leafId];
            delete paneRegistry.value[leafId];
            lastRemovedLeafId.value = leafId;
          })();
        } else {
          // Claude セッションを持たない pane（spawn 前 / 素 PTY のみ）は同期で完結。
          ptySession.killPty(leafId);
          delete cwdByLeafId.value[leafId];
          delete titleByLeafId.value[leafId];
          delete pendingResumeByLeafId.value[leafId];
          delete paneRegistry.value[leafId];
          lastRemovedLeafId.value = leafId;
        }
      },
      getPaneDir: (leafId) => paneRegistry.value[leafId]?.dir,
      getLeafIdsByDir: (dir) =>
        Object.entries(paneRegistry.value)
          .filter(([, entry]) => entry.dir === dir)
          .map(([leafId]) => leafId),
    },
    resetTerminalFocus: () => contextKeys.set("terminalFocus", false),
  });

  // --- computed ---

  /** Claude セッションが存在する（idle / working / asking / done）leafId 一覧 */
  const claudeActiveLeafIds = computed(() => claude.getClaudeActiveLeafIds());

  /**
   * 表示用の実効モード。`userViewMode === "claude"` でも Claude leaf が 0 件なら
   * `wt` として解釈する。これにより:
   *  - claude ビュー中に split で素 PTY を増やしても、新 pane が見える wt として描画
   *  - Claude セッション全終了で空タイル（真っ黒）にならない
   *  - 各コマンド handler / store watch で「if claude then wt」を書く必要がない
   * setter は `userViewMode` への代入を転送し、既存の `terminalStore.viewMode = "wt"`
   * のような呼び出し（SidebarPane / useWorktreeActions / register*Command 等）を
   * 改変なしで動かす。
   */
  const viewMode = computed<ViewMode>({
    get: () => {
      if (userViewMode.value === "claude" && claudeActiveLeafIds.value.length === 0) {
        return "wt";
      }
      return userViewMode.value;
    },
    set: (mode) => {
      userViewMode.value = mode;
    },
  });

  /** wt ↔ claude をトグルする（ユーザー意図側を切替）。 */
  function toggleViewMode() {
    userViewMode.value = userViewMode.value === "wt" ? "claude" : "wt";
  }

  // --- RPC 購読 ---

  /** HMR 再実行時に前回のリスナーを解除するための disposer */
  let disposeDataListener: (() => void) | undefined;
  let disposeExitListener: (() => void) | undefined;
  let disposeHookListener: (() => void) | undefined;

  function initSubscriptions() {
    disposeDataListener?.();
    disposeExitListener?.();
    disposeHookListener?.();

    // HMR で Map が再初期化されるため、paneRegistry から逆引きを復元
    ptySession.rebuildPtyIdMap();

    disposeDataListener = onMessage<PtyTextPayload>("ptyText", ({ id, text }) => {
      ptySession.handlePtyData(id, text);
    });

    disposeExitListener = onMessage<PtyExitPayload>("ptyExit", ({ id }) => {
      ptySession.handlePtyExit(id);
    });

    disposeHookListener = onMessage<HookPayload>("hook", (payload) => {
      const { event, ptyId } = payload;
      if (!isHookEvent(event)) return;
      // claudeStatus.ts は snake_case の payload を期待するので boundary で変換する
      claude.handleHookEvent(ptyId, event, {
        session_id: payload.sessionId,
        last_assistant_message: payload.lastAssistantMessage,
        tool_name: payload.toolName,
        tool_input: payload.toolInput,
        is_interrupt: payload.isInterrupt,
      });
    });
  }

  initSubscriptions();

  // --- saved Claude セッション件数 ---

  /**
   * 指定プロジェクト全体の保存セッション数を再取得して savedSessionCountByDir を更新する。
   * - `worktreePaths`: そのプロジェクトに属する worktree の絶対パス一覧。
   *   このリストに含まれる既存エントリを一旦消してから fetch 結果で埋め直すことで、
   *   ある worktree が 0 件になったケースもバッジから消える。
   * - `anyDirInProject`: projectKey 解決に使う任意の dir（root でも worktree でも可）。
   */
  async function refreshSavedSessionCounts(
    worktreePaths: string[],
    anyDirInProject: string,
  ): Promise<void> {
    const gen = (refreshGenByAnchor.get(anyDirInProject) ?? 0) + 1;
    refreshGenByAnchor.set(anyDirInProject, gen);

    const fetched = await tryCatch(rpcClaudeSessionListByProject({ dir: anyDirInProject }));
    // stale: 古い世代の結果は破棄する。新しい呼び出し側の値を尊重する。
    if (refreshGenByAnchor.get(anyDirInProject) !== gen) return;
    if (!fetched.ok) {
      notify.error("Failed to load saved Claude sessions", fetched.error);
      return;
    }
    // 最新世代の結果が確定したタイミングで、対象 worktree の count を一旦消して
    // fetch 結果で埋め直す。await 前に消すと、fetch 中はバッジが一瞬消える挙動になる。
    for (const path of worktreePaths) {
      delete savedSessionCountByDir.value[path];
    }
    for (const session of fetched.value.sessions) {
      const path = session.worktreePath;
      savedSessionCountByDir.value[path] = (savedSessionCountByDir.value[path] ?? 0) + 1;
    }
  }

  /**
   * 指定 worktree の「resume 可能なセッション数」。永続化セッション数から、
   * 既に live PTY 上で動作している Claude の数を引いた残り。
   * - 未訪問 worktree: live=0 なので保存数がそのまま出る
   * - 訪問済み + 全 resume 完了: live=saved で 0
   */
  function getResumeableSessionCount(dir: string): number {
    const saved = savedSessionCountByDir.value[dir] ?? 0;
    if (saved === 0) return 0;
    const live = claude.getClaudeStatusesByDir(dir).length;
    return Math.max(0, saved - live);
  }

  // --- worktree visit + Claude セッション復元 ---

  /**
   * worktree を訪問する。初回 visit 時に保存済み Claude セッションを引き、
   * セッション数だけ leaf を split で生成して各 leaf に resume sessionId を仕込む。
   * 2 回目以降の visit は何もしない（既存レイアウトを維持）。
   *
   * 非同期だが呼び出し側の watch ハンドラは await しない。
   * 順序の正しさは visitGenByDir の世代チェックで担保する：
   * - fetch 失敗時に visitedDirs を汚さないため、visitedDirs.push は await 後に行う
   * - await 中に同じ dir で別の visit が走った場合、古い世代の処理は中断する
   */
  async function visit(dir: string): Promise<void> {
    if (visitedDirs.value.includes(dir)) {
      // 既に訪問済みなら何もしない（既存レイアウトを維持）
      return;
    }
    const gen = (visitGenByDir.get(dir) ?? 0) + 1;
    visitGenByDir.set(dir, gen);

    const fetched = await tryCatch(rpcClaudeSessionListByDir({ dir }));
    if (visitGenByDir.get(dir) !== gen) return;
    if (!fetched.ok) {
      // fetch 失敗時は visitedDirs を汚さず、ユーザーに通知して終了。
      // 復元情報なしで起動すると意図しない素 PTY が走り Claude セッションを失うため、
      // ここで止めて再試行（次回の visit）に委ねる。
      notify.error(`Failed to load Claude sessions for ${dir}`, fetched.error);
      return;
    }

    visitedDirs.value.push(dir);
    let sessions = fetched.value.sessions;

    // サイドバーで resumable Task をクリックして visit を誘発したケース。
    // 該当 sessionId を必ず先頭 (= initial focused leaf) に乗せる。
    const preferred = preferredResumeByDir.value[dir];
    if (preferred !== undefined) {
      delete preferredResumeByDir.value[dir];
      const idx = sessions.findIndex((s) => s.sessionId === preferred);
      if (idx > 0) {
        const reordered = [...sessions];
        const [pick] = reordered.splice(idx, 1);
        if (pick !== undefined) reordered.unshift(pick);
        sessions = reordered;
      } else if (idx < 0) {
        // click と visit の間に session listing から該当 sessionId が消えた。
        // 期待した session の resume はできないので、ユーザーに知らせる
        // (silent に先頭 session を起動すると click の意図がすり替わる)。
        // 本文は短く、診断情報 (sessionId / dir) は cause に逃がして展開表示で見せる。
        notify.error(
          "Selected resumable session is no longer available",
          new Error(`sessionId=${preferred} dir=${dir}`),
        );
      }
    }

    // ensureLayout で初期 leaf を作る（既存の単一 leaf 起動と同じ）
    const initialLayout = layout.ensureLayout(dir);
    const initialLeafId = initialLayout.focusedLeafId;
    const [firstSession, ...remainingSessions] = sessions;
    if (firstSession !== undefined) {
      pendingResumeByLeafId.value[initialLeafId] = firstSession.sessionId;
    } else if (preferredAutostartByDir.value[dir]) {
      // session 未紐付け task クリックで visit を誘発したケース。
      // resume すべき session が無いので、初期 leaf で素の claude を autostart する。
      delete preferredAutostartByDir.value[dir];
      pendingAutostartByLeafId.value[initialLeafId] = true;
    }
    // 2 つ目以降のセッションは split で leaf を増やす
    for (const session of remainingSessions) {
      const newLeafId = layout.splitPane(dir, "horizontal");
      if (newLeafId !== undefined) {
        pendingResumeByLeafId.value[newLeafId] = session.sessionId;
      }
    }
  }

  /**
   * サイドバーから resumable Task をクリックしたときに呼ぶ。
   * - 未訪問: 次回の visit で当該 sessionId を先頭 leaf に乗せるヒントを残す。
   *   呼び出し元が直後に setOpen → TerminalPane の watch が visit を駆動する。
   * - 訪問済み: その場で split して新 leaf に sessionId を紐付け、フォーカスを移す。
   * 当該 sessionId が既に live PTY を持っているなら何もしない (上位で focus 済み)。
   */
  function requestResumeSession(dir: string, sessionId: string) {
    // click → onSelectTask 内で `getPtyIdBySessionId === undefined` を確認済み。
    // ここに来てなお live になっているのは「click と本関数呼び出しの間に session-start
    // hook が走った」ごく狭い race のみ。観察用に debug ログを残し、focus は上位の
    // 経路 (focusPane) に任せて return する。
    if (claude.getPtyIdBySessionId(sessionId) !== undefined) {
      console.debug(
        `[useTerminalStore] requestResumeSession: ${sessionId} became live between click and request; deferring focus to caller`,
      );
      return;
    }
    if (!visitedDirs.value.includes(dir)) {
      preferredResumeByDir.value[dir] = sessionId;
      return;
    }
    const newLeafId = layout.splitPane(dir, "horizontal");
    if (newLeafId === undefined) {
      // split に失敗するとユーザーの click が無反応に終わる。silent return は
      // 観察可能性を欠くので notify する (発生条件: layout 制約 / dir 未初期化)。
      // 本文は短く、診断情報 (dir / sessionId) は cause で展開表示。
      notify.error(
        "Failed to open resume session",
        new Error(`splitPane returned undefined; dir=${dir} sessionId=${sessionId}`),
      );
      return;
    }
    pendingResumeByLeafId.value[newLeafId] = sessionId;
    layout.focusPane(newLeafId);
  }

  /**
   * サイドバーから session 未紐付け task (PR/issue 由来等) をクリックしたときに呼ぶ。
   * - 未訪問: 次回の visit で初期 leaf を素の claude 起動として生成するヒントを残す。
   * - 訪問済み: その場で split して新 leaf に autostart フラグを仕込み、フォーカスを移す。
   *
   * SessionStart hook が走ると server 側 attachSession が「sessionId 空の最新 task」
   * に新 sessionId を結びつける。クリックした task と attach 先が一致するのは
   * 「wt に sessionId 空の task が 1 つだけ」のケース。複数ある場合は最新が選ばれる。
   */
  function requestNewClaudeSession(dir: string) {
    if (!visitedDirs.value.includes(dir)) {
      preferredAutostartByDir.value[dir] = true;
      return;
    }
    const newLeafId = layout.splitPane(dir, "horizontal");
    if (newLeafId === undefined) {
      notify.error(
        "Failed to start Claude session",
        new Error(`splitPane returned undefined; dir=${dir}`),
      );
      return;
    }
    pendingAutostartByLeafId.value[newLeafId] = true;
    layout.focusPane(newLeafId);
  }

  /**
   * worktree が外部削除された / アクティブから外れたときの cleanup。
   * `layout.remove` を呼ぶ前に visitGenByDir の世代を進めることで、
   * 進行中の `visit` の await 後 world は stale 判定で破棄される。
   * これにより、削除済み worktree の遅延 fetch 結果が `ensureLayout` を
   * 復活させる race を防ぐ。
   */
  function removeWorktreeFromLayout(dir: string) {
    visitGenByDir.set(dir, (visitGenByDir.get(dir) ?? 0) + 1);
    // 未消費の resume ヒントを掃除する。worktree が削除→再作成された後の visit に
    // 古いヒントが流れ込まないよう、layout 撤去と同じタイミングで落とす。
    delete preferredResumeByDir.value[dir];
    delete preferredAutostartByDir.value[dir];
    layout.remove(dir);
  }

  // --- pane getter ---

  /** leafId に対応するペーンの dir を返す */
  function getPaneDir(leafId: string): string | undefined {
    return paneRegistry.value[leafId]?.dir;
  }

  /** leafId に対応する PTY の ptyId を返す */
  function getPtyId(leafId: string): number | undefined {
    return paneRegistry.value[leafId]?.session?.ptyId;
  }

  /**
   * `paneRegistry` (ウィンドウ全体の leaf 数) からの逆引き Map。session-start /
   * tool-done など hook イベントの度に参照されるため、毎回 Object.entries で
   * 線形探索すると wt 数 × leaf 数のコストが乗る。computed で派生させて
   * `paneRegistry` 変化時にのみ再構築する。
   */
  const leafIdByPtyId = computed(() => {
    const map = new Map<number, string>();
    for (const [leafId, pane] of Object.entries(paneRegistry.value)) {
      const ptyId = pane?.session?.ptyId;
      if (ptyId !== undefined) map.set(ptyId, leafId);
    }
    return map;
  });

  /** ptyId に対応する leafId を返す。`leafIdByPtyId` 経由で O(1) */
  function getLeafIdByPtyId(ptyId: number): string | undefined {
    return leafIdByPtyId.value.get(ptyId);
  }

  // --- CWD ---

  /** OSC 7 で通知された CWD を保存する */
  function setCwd(leafId: string, cwd: string) {
    cwdByLeafId.value[leafId] = cwd;
  }

  /** OSC 0/2 で通知されたタイトルを保存する */
  function setTitle(leafId: string, title: string) {
    if (title === "") {
      delete titleByLeafId.value[leafId];
    } else {
      titleByLeafId.value[leafId] = title;
    }
    lastTitleUpdate.value = { leafId, title };
  }

  // --- drag suspend ---

  function incrementDragSuspend() {
    dragSuspendCount.value++;
  }

  function decrementDragSuspend() {
    dragSuspendCount.value = Math.max(0, dragSuspendCount.value - 1);
  }

  return {
    // state
    visitedDirs,
    layoutsByDir,
    dragSuspendCount,
    viewMode,
    toggleViewMode,
    cwdByLeafId,
    titleByLeafId,
    lastTitleUpdate,
    lastRemovedSessionInfo,
    lastRemovedLeafId,
    // computed
    claudeActiveLeafIds,
    // layout
    visit,
    requestResumeSession,
    requestNewClaudeSession,
    splitPane: layout.splitPane,
    closePane: layout.closePane,
    resetLayout: layout.resetLayout,
    resizeBranch: layout.resizeBranch,
    focusPane: layout.focusPane,
    remove: removeWorktreeFromLayout,
    // pty
    spawnPty: ptySession.spawnPty,
    killPty: ptySession.killPty,
    attachTerminal: ptySession.attachTerminal,
    // claude
    getClaudeState: claude.getClaudeState,
    getClaudeStatusesByDir: claude.getClaudeStatusesByDir,
    getClaudeStatusBySessionId: claude.getStatusBySessionId,
    getPtyIdBySessionId: claude.getPtyIdBySessionId,
    getSessionIdByPtyId: claude.getSessionIdByPtyId,
    clearDoneStates: claude.clearDoneStates,
    // saved sessions (resume バッジ用)
    refreshSavedSessionCounts,
    getResumeableSessionCount,
    // pane getter
    getPaneDir,
    getPtyId,
    getLeafIdByPtyId,
    // cwd
    setCwd,
    // title
    setTitle,
    // drag
    incrementDragSuspend,
    decrementDragSuspend,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTerminalStore, import.meta.hot));
}
