import { tryCatch } from "@gozd/shared";
import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { useContextKeys } from "../../shared/command";
import { useNotificationStore } from "../../shared/notification";
import { dispatchMessage, onMessage } from "../../shared/rpc";
import type { ClaudeStatus } from "./claudeStatus";
import { isHookEvent, createClaudeStatusManager } from "./claudeStatus";
import { createPtySessionManager } from "./ptySession";
import type { PaneEntry } from "./ptySession";
import { buildResumeSessionIds } from "./resumeSessionIds";
import type { HookPayload, PtyExitPayload, PtyTextPayload } from "./rpc";
import {
  rpcClaudeSessionRemoveByPty,
  rpcPtyKill,
  rpcPtySpawn,
  rpcResumableSessionList,
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
   * leafId → resume 起動中の Claude sessionId。2 用途のヒントを兼ねる:
   *   - 起動 env 注入: spawnPty が env 組み立て時に snapshot で読み、GOZD_RESUME_CLAUDE_SESSION
   *     として 1 回だけ乗せる
   *   - 連打 dedup: requestResumeSession が sessionId 逆引きで「同 sid の resume が in-flight」
   *     を判定し、新 pane を作らず既存 leaf を focus に倒す
   * lifecycle: requestResumeSession で set。session-start hook 到達時に onSessionAttached
   * から削除 (起動成功経路)。spawn 失敗時に requestPtySpawn の catch で削除 (起動失敗経路)。
   * unregisterPane でも leaf 終端の cleanup として削除。
   */
  const pendingResumeByLeafId = ref<Record<string, string>>({});

  /**
   * 未訪問 worktree に対する「visit で最初の leaf に乗せたい sessionId」のヒント。
   * サイドバーで resumable な Task 行をクリックしたとき、setOpen 起点の自動 visit が
   * savedSessionIds の先頭順で leaf を割り当てて意図がずれるのを防ぐ。visit 内で
   * 1 回だけ消費し、対象 dir の前置きとして使う。
   */
  const preferredResumeByDir = ref<Record<string, string>>({});

  /**
   * autostart ヒント。prefill は claude の入力欄に事前挿入するテキスト
   * (`claude --prefill <text>`。挿入のみで送信はされない)。
   * PR/issue picker が worktree 作成時に PR/issue URL を渡す。
   */
  type AutostartHint = { prefill?: string };

  /**
   * leafId → 次回 spawn 時に GOZD_AUTOSTART_CLAUDE フラグを立てる印。
   * session 未紐付け task (PR/issue 経由で worktree のみ作成された等) をクリック
   * した時に、resume ではなく素の `claude` を起動するために使う。spawnPty が env
   * を組み立てるタイミングで一度だけ消費する。
   */
  const pendingAutostartByLeafId = ref<Record<string, AutostartHint>>({});

  /**
   * 未訪問 worktree に対する「visit で最初の leaf に autostart フラグを乗せる」ヒント。
   * preferredResumeByDir と排他的に使う。visit 内で 1 回だけ消費する。
   */
  const preferredAutostartByDir = ref<Record<string, AutostartHint>>({});

  /**
   * worktree 作成直後に「専用 leaf で setup スクリプトを実行する」ヒント（値 = スクリプト本体）。
   * 作成経路（addWorktree / issue・pr picker）だけが setPreferredSetup で立てる。visit()（初回
   * オープン）で消費する — visit はアプリ再起動後の既存 worktree オープンでも走るため、
   * 無条件実行だと開くたび再走する。作成時だけヒントがあることで「作成時 1 回」に限定する。
   */
  const preferredSetupByDir = ref<Record<string, string>>({});

  /**
   * leafId → 次回 spawn 時に GOZD_SETUP_SCRIPT として注入する setup スクリプト。
   * zsh init の _gozd_run_setup が eval で実行する。spawnPty が env 組み立て時に 1 回だけ消費する。
   */
  const pendingSetupByLeafId = ref<Record<string, string>>({});

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
      // 起動 env 注入: spawn 開始時に snapshot を取る。zsh init が
      // GOZD_RESUME_CLAUDE_SESSION を見て `claude --resume <id>` を 1 回だけ起動する。
      const resumeId = pendingResumeByLeafId.value[leafId];
      if (resumeId !== undefined) {
        env.GOZD_RESUME_CLAUDE_SESSION = resumeId;
      }
      const autostart = pendingAutostartByLeafId.value[leafId];
      if (autostart) {
        env.GOZD_AUTOSTART_CLAUDE = "1";
        if (autostart.prefill !== undefined && autostart.prefill !== "") {
          env.GOZD_CLAUDE_PREFILL = autostart.prefill;
        }
      }
      const setupScript = pendingSetupByLeafId.value[leafId];
      if (setupScript !== undefined && setupScript !== "") {
        env.GOZD_SETUP_SCRIPT = setupScript;
      }
      const res = await tryCatch(
        rpcPtySpawn({
          dir,
          executable: DEFAULT_SHELL,
          args: DEFAULT_SHELL_ARGS,
          env,
          rows,
          cols,
          worktreePath: dir,
        }),
      );
      if (!res.ok) {
        // spawn 失敗時は pending ヒントを掃除する。残すと requestResumeSession の dedup loop
        // が「起動できなかった leaf」を ヒットさせて存在しない pane に focus 試行する事故を
        // 起こす。env は snapshot 済みなので削除しても再 spawn 時の挙動は変わらない。
        if (resumeId !== undefined) {
          delete pendingResumeByLeafId.value[leafId];
        }
        if (autostart) {
          delete pendingAutostartByLeafId.value[leafId];
        }
        delete pendingSetupByLeafId.value[leafId];
        throw res.error;
      }
      // pendingResumeByLeafId は spawn 成功時点では削除しない。session-start hook の
      // 到達まで保持して、その間の重複クリックを requestResumeSession で focus に倒す。
      // (削除は claudeStatus の onSessionAttached コールバックで行う)
      if (autostart) {
        delete pendingAutostartByLeafId.value[leafId];
      }
      delete pendingSetupByLeafId.value[leafId];
      return res.value.ptyId;
    },
    sendPtyKill: ({ id }) => {
      void rpcPtyKill({ ptyId: id });
    },
    onPtyCleanup: (ptyId) => claude.cleanupPty(ptyId),
    onSpawnError: ({ dir, error }) => {
      // spawn 失敗をユーザーに通知する。resume 連打 dedup の catch path 経由で
      // pendingResumeByLeafId を消すと requestPtySpawn が throw するため、無反応で終わらない
      // よう必ず通知に倒す。dir は外側 Error の message に載せ、元 error は cause に
      // 包んで stack / 詳細を残す (cause 展開で worktree も診断できる)。
      notify.error(
        "Failed to spawn terminal",
        new Error(`spawn failed; dir=${dir}`, { cause: error }),
      );
    },
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
    onSessionAttached: (ptyId) => {
      // session-start で sessionId が live mapping に乗ったので、対応 leaf の
      // resume pending ヒントを掃除する。これ以降は claude.getPtyIdBySessionId が
      // 引けるため requestResumeSession 側の dedup は live PTY check で完結する。
      // ptyId → leafId 逆引きは leafIdByPtyId computed (SSOT) を経由する。
      const leafId = leafIdByPtyId.value.get(ptyId);
      if (leafId !== undefined) {
        delete pendingResumeByLeafId.value[leafId];
      }
    },
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
        // アプリ終了時は renderer ごと死ぬためこの経路を通らず、task.sessionId は
        // そのまま残り次回 resume できる。
        // ptyId は paneRegistry が保持しているので hook 到達順に依存せず確実に渡せる。
        const entry = paneRegistry.value[leafId];
        const ptyId = entry?.session?.ptyId;
        const dir = entry?.dir;
        if (ptyId !== undefined && dir !== undefined) {
          // 削除 RPC を先行させ、await してから killPty を呼ぶ。
          // killPty を先に投げると native の consumers task が `remove(id:)` で
          // sessionIdById を消した後に削除 RPC が到達して sessionId nil ですり抜け、
          // task の sessionId が detach されず残る race の窓が空く。
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
            } else if (res.value.removedSessionId !== "") {
              // main 側で taskStore.detachSession が走り、ghRef 有無に関わらず task は
              // 残る (closed_by_user=true + sessionID 保持で `closed` 状態に倒れる)。
              // useSidebarData がこの ref を watch して所属 repo を refetch することで、
              // WorktreeEntry.tasks 側の closed_by_user 反映を取り込む。
              // terminalStore は repoStore に依存させない (Pinia setup での循環を避ける)。
              lastRemovedSessionInfo.value = {
                dir,
                sessionId: res.value.removedSessionId,
              };
            }
            // removedSessionId が空 = claude を一度も起動せず close した pane。
            // 永続化に変化が無いので refetch を skip し、サイドバーの無駄な発火を防ぐ。
            // 削除 RPC の完了後に kill。失敗時も pane の UI は閉じる契約なので
            // kill は実行する。paneRegistry にまだ entry があるので killPty は有効。
            ptySession.killPty(leafId);
            delete titleByLeafId.value[leafId];
            delete pendingResumeByLeafId.value[leafId];
            delete pendingAutostartByLeafId.value[leafId];
            delete pendingSetupByLeafId.value[leafId];
            delete paneRegistry.value[leafId];
            lastRemovedLeafId.value = leafId;
          })();
        } else {
          // Claude セッションを持たない pane（spawn 前 / 素 PTY のみ）は同期で完結。
          ptySession.killPty(leafId);
          delete titleByLeafId.value[leafId];
          delete pendingResumeByLeafId.value[leafId];
          delete pendingAutostartByLeafId.value[leafId];
          delete pendingSetupByLeafId.value[leafId];
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
      const fx = claude.handleHookEvent(ptyId, event, {
        session_id: payload.sessionId,
        last_assistant_message: payload.lastAssistantMessage,
        tool_name: payload.toolName,
        tool_input: payload.toolInput,
        pending_work: payload.pendingWork,
      });
      // 効果（音・演出・読み上げ）は正規化済みの claudeFx ストリームに流す。pending done 等の
      // 「完了扱いしない hook」は handleHookEvent が undefined を返して落とすので、購読側は
      // pending を意識せず受け取れる（判断は handleHookEvent 1 箇所に集約）。
      if (fx !== undefined) dispatchMessage("claudeFx", fx);
    });
  }

  initSubscriptions();

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

    const fetched = await tryCatch(rpcResumableSessionList({ dir }));
    if (visitGenByDir.get(dir) !== gen) return;
    if (!fetched.ok) {
      // fetch 失敗時は visitedDirs を汚さず、ユーザーに通知して終了。
      // 復元情報なしで起動すると意図しない素 PTY が走り Claude セッションを失うため、
      // ここで止めて再試行（次回の visit）に委ねる。
      notify.error(`Failed to load Claude sessions for ${dir}`, fetched.error);
      return;
    }

    visitedDirs.value.push(dir);
    const savedSessionIds = fetched.value.sessionIds;

    // 復元する sessionId 列を組み立てる。preferred はサイドバーで resumable / closed
    // Task をクリックして visit を誘発したケースの sessionId (= task.sessionId)。
    //
    // savedSessionIds は rpcResumableSessionList が返す resumable 集合 (tasks.json の
    // sessionId 有 + !closedByUser、= app close で中断され残ったもの)。ユーザーが明示
    // クリックした closed task (closedByUser=true) はこの集合に含まれないため、preferred
    // が saved に無いのは異常ではなく通常ケース。保存リストでの検証はせず、明示クリックを
    // 尊重して preferred を常に先頭 (= initial focused leaf) に置く (重複は除外)。これは
    // 訪問済み経路の requestResumeSession が saved を参照せず直接 resume するのと同じ流儀。
    // resume が真に不能なら native 側の dead session 清掃が hook 経路で処理する。
    // 列組み立ては境界条件 (preferred の有無 / saved 重複) を持つので純関数に分離。
    const preferred = preferredResumeByDir.value[dir];
    if (preferred !== undefined) delete preferredResumeByDir.value[dir];
    const resumeSessionIds = buildResumeSessionIds(preferred, savedSessionIds);

    // ensureLayout で初期 leaf を作る（既存の単一 leaf 起動と同じ）
    const initialLayout = layout.ensureLayout(dir);
    const initialLeafId = initialLayout.focusedLeafId;
    const [firstSessionId, ...remainingSessionIds] = resumeSessionIds;
    if (firstSessionId !== undefined) {
      pendingResumeByLeafId.value[initialLeafId] = firstSessionId;
    }
    // 2 つ目以降のセッションは split で leaf を増やす
    for (const sessionId of remainingSessionIds) {
      const newLeafId = layout.splitPane(dir, "horizontal");
      if (newLeafId !== undefined) {
        pendingResumeByLeafId.value[newLeafId] = sessionId;
      }
    }
    // session 未紐付け task クリックで visit を誘発したケース。saved session の resume
    // とは排他ではなく共存させる (訪問済み経路の requestNewClaudeSession と同じ流儀):
    // - firstSessionId 無し → 初期 leaf を直接 autostart に
    // - firstSessionId あり → 追加 leaf を split して autostart + focus
    const autostartHint = preferredAutostartByDir.value[dir];
    if (autostartHint) {
      delete preferredAutostartByDir.value[dir];
      if (firstSessionId === undefined) {
        pendingAutostartByLeafId.value[initialLeafId] = autostartHint;
      } else {
        const autostartLeafId = layout.splitPane(dir, "horizontal");
        if (autostartLeafId !== undefined) {
          pendingAutostartByLeafId.value[autostartLeafId] = autostartHint;
          layout.focusPane(autostartLeafId);
        }
      }
    }

    // worktree 作成直後の setup スクリプトを専用 leaf で実行する。resume / autostart とは
    // 独立した split leaf に載せる。splitPane は新 leaf に focus を移すため、split 前の
    // focus（初期の作業 leaf、または autostart leaf）を退避して復元する。setup は裏で
    // 並走させ、焦点は最初のターミナルに残す。
    const setupScript = preferredSetupByDir.value[dir];
    if (setupScript !== undefined && setupScript !== "") {
      delete preferredSetupByDir.value[dir];
      const focusBeforeSetup = layoutsByDir.value[dir]?.focusedLeafId;
      const setupLeafId = layout.splitPane(dir, "horizontal");
      if (setupLeafId !== undefined) {
        pendingSetupByLeafId.value[setupLeafId] = setupScript;
        if (focusBeforeSetup !== undefined) layout.focusPane(focusBeforeSetup);
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
    // hook が走った」ごく狭い race。caller (SidebarPane.onSelectTask) は live PTY check の
    // 後で requestResumeSession に入る経路では focus を呼ばないため、ここで focus に倒す。
    const livePtyId = claude.getPtyIdBySessionId(sessionId);
    if (livePtyId !== undefined) {
      const liveLeafId = leafIdByPtyId.value.get(livePtyId);
      if (liveLeafId !== undefined) layout.focusPane(liveLeafId);
      return;
    }
    // 連打ガード: 同一 sessionId の resume が in-flight (spawn 中 / claude --resume
    // 起動中で session-start hook 未到達) なら、その leaf を focus するに留めて
    // 新 pane を増やさない。pendingResumeByLeafId は session-start で消化されるまで
    // 残るため、ここでの逆引きが double-spawn の唯一の防壁になる。
    // 残骸判定の軸は 2 つ。これ以外 (= leaf あり + session 未確立 / leaf あり + PTY 生存) は
    // in-flight として focus に倒す。session === undefined の spawn 中状態を「dead」と
    // 読むと spawn await 中の連打が double-spawn に逆戻りするため、判定軸を慎重に分ける。
    //   - leaf 自体が paneRegistry から消えた
    //   - spawn 完了済み (session あり) で PTY が死亡 (claude --resume 失敗で zsh exit 等)
    for (const [pendingLeafId, pendingSid] of Object.entries(pendingResumeByLeafId.value)) {
      if (pendingSid !== sessionId) continue;
      const pane = paneRegistry.value[pendingLeafId];
      if (pane === undefined) {
        delete pendingResumeByLeafId.value[pendingLeafId];
        continue;
      }
      const pendingPtyId = pane.session?.ptyId;
      if (pendingPtyId !== undefined && !ptySession.isPtyAlive(pendingPtyId)) {
        delete pendingResumeByLeafId.value[pendingLeafId];
        continue;
      }
      layout.focusPane(pendingLeafId);
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
   *
   * prefill を渡すと `claude --prefill <text>` で入力欄にテキストを事前挿入する
   * (送信はされない)。PR/issue picker が PR/issue URL を渡す用途。
   */
  function requestNewClaudeSession(dir: string, prefill?: string) {
    const hint: AutostartHint = prefill === undefined ? {} : { prefill };
    if (!visitedDirs.value.includes(dir)) {
      preferredAutostartByDir.value[dir] = hint;
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
    pendingAutostartByLeafId.value[newLeafId] = hint;
    layout.focusPane(newLeafId);
  }

  /**
   * worktree 作成経路（addWorktree / issue・pr picker）が呼ぶ。次回の visit で専用 leaf を
   * 立てて setup スクリプトを実行するヒントを残す。呼び出し元が直後に setOpen して
   * TerminalPane の watch が visit を駆動する（preferredResume / preferredAutostart と同流儀）。
   */
  function setPreferredSetup(dir: string, script: string) {
    if (script === "") return;
    preferredSetupByDir.value[dir] = script;
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
    delete preferredSetupByDir.value[dir];
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

  /** OSC 0/2 で通知されたタイトルを保存する */
  function setTitle(leafId: string, title: string) {
    if (title === "") {
      delete titleByLeafId.value[leafId];
    } else {
      titleByLeafId.value[leafId] = title;
    }
    lastTitleUpdate.value = { leafId, title };
    // Claude の状態 (working / idle) は OSC タイトルのスピナー/✳ プレフィックスから導出する。
    // session が確立している leaf のみ observeTitle 内で反応する。
    const ptyId = getPtyId(leafId);
    if (ptyId !== undefined) claude.observeTitle(ptyId, title);
  }

  /**
   * 可視画面本文から asking の離脱（承認せずキャンセル / 中断）を検知する。
   * XtermTerminal の描画確定フック（onWriteParsed）から呼ぶ。screen text は asking のときだけ
   * 読めばよいため遅延取得の関数で渡す（observeScreen 内で asking 以外なら呼ばれない）。
   */
  function observeScreen(leafId: string, readScreenText: () => string) {
    const ptyId = getPtyId(leafId);
    if (ptyId !== undefined) claude.observeScreen(ptyId, readScreenText);
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
    setPreferredSetup,
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
    // pane getter
    getPaneDir,
    getPtyId,
    getLeafIdByPtyId,
    // title
    setTitle,
    // screen（画面本文から asking 離脱を検知）
    observeScreen,
    // drag
    incrementDragSuspend,
    decrementDragSuspend,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTerminalStore, import.meta.hot));
}
