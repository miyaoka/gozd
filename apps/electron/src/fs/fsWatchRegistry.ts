// dir 単位でファイル監視を保持し、再帰的なファイル変更を push event に振り分ける registry。
// Swift 版 `FSWatchRegistry.swift`（actor）の対応物。分類の設計判断は `classify.ts` 冒頭を参照。
//
// Swift 版との構造差分:
//
// - **FSEvents stream → @parcel/watcher subscription**。Swift は 1 stream に
//   [worktree root, per-worktree git dir, common git dir] の複数 root を登録できるが、
//   @parcel/watcher は 1 subscribe = 1 root で、root 配下を再帰的に監視する。各 entry は
//   dir と git dir の最小被覆を root に持ち（通常 clone: `.git` は root 配下 → 1 本。
//   worktree: per-wt git dir は common 配下 → [worktree root, common git dir] の 2 本）、
//   registry は全 entry の root をそれぞれ subscribe する。root が別の root を含むとき
//   （repo 内に置いた worktree、main repo の `.git` を common git dir に持つ worktree）は、
//   含む側の ignore に含まれる側の絶対パスを加え、同じ event を二重に配送しない。除外パターンは
//   各 root 自身からの相対で当たり、git dir の root には掛からない。event は path を含む entry に
//   振り分ける。
// - **actor → 素の closure state**。Node はシングルスレッドで排他は不要だが、await
//   （gitDirs 解決 / refDigest / git status）を跨ぐ間に unwatch や後続 event が割り込む
//   構造は同じなので、await 前後で watch 世代を確かめる。同じ dir の status 取得は
//   single-flight で直列化し、古い取得が新しい結果を上書きしない。subscribe の張り直しも
//   直列化し、並行した張り直しが互いの途中状態を見て監視を途切れさせない。
// - **構築中の同 dir 並行 watch は pendingWatches で直列化**。Swift actor にも
//   `await gitDirs` 中の reentrancy 窓（entry の二重構築）があるが、こちらは構築 promise を
//   待たせて、refCount と entry の上書きを構造的に塞ぐ。
//
// 主要な設計判断（Swift 版から継承）:
//
// - **push の重複は許容**。renderer 側は冪等な再 fetch で受け止める。
// - **branchChange / remoteRefsChange / head 由来 worktreeChange は digest gating**。
//   path 分類は「ref store が動いた候補」までしか分からず（reftable backend は local /
//   remote / HEAD が 1 テーブルに同居）、candidate が立った primary watcher で
//   `refDigest` を読み、前回値と差があるカテゴリだけ dispatch する。これが無いと commit の
//   たびに remoteRefsChange が飛び、renderer の PR 取得が GitHub rate limit を食い潰す。
// - **repo-scope event は primary watcher（main worktree）1 つに collapse**。同 repo を
//   共有する N worktree の watcher が同じ common git dir event で同時発火するため。
// - **working-tree 由来の git status は trailing-debounce**。checkout flood の N バッチを
//   最新 1 回の status 取得に畳む（issue #809）。branch label は ref 系経路が即時駆動する。
// - **内容不変の gitStatusChange は dedup**。gitignore 対象（ビルド成果物等）の書き込みは
//   作業ツリー event として候補が立つが git status 出力は不変のため、直近 push 値と一致する
//   間は push しない。

import { tryCatch } from "@gozd/shared";
import { realpathSync } from "node:fs";
import { withGitTier } from "../git/gitAdmission";
import { gitDirs, gitStatusFull, refDigest, type RefDigest } from "../git/gitOps";
import type { StatusFull } from "../git/porcelain";
import { classify, relativeUnder } from "./classify";

/** 1 subscription の破棄ハンドル。@parcel/watcher の AsyncSubscription を transport 越しに抽象化 */
export interface WatchHandle {
  unsubscribe(): Promise<void>;
}

/** native watcher への subscribe 経路を抽象化する。production は utilityProcess 隔離した
 * watcherClient を注入し、テストは callback を捕まえる偽物を注入する。
 * これにより fsWatchRegistry は @parcel/watcher / electron に直接依存しない（classify 層を
 * native crash から切り離す境界）。onEvents は event path の配列、onError は文字列メッセージ */
export interface WatchTransport {
  subscribe(
    root: string,
    ignore: string[],
    onEvents: (paths: string[]) => void,
    onError: (message: string) => void,
  ): Promise<WatchHandle>;
}

export interface FsWatchHandlers {
  onFsChange: (dir: string, relDir: string) => void;
  onGitStatusChange: (dir: string, status: StatusFull) => void;
  /** 同 repo を共有する worktree 群の中から primary 1 つだけが発火するため、
   * push は repo につき 1 回 / バッチ */
  onBranchChange: (dir: string) => void;
  onRemoteRefsChange: (dir: string) => void;
  onWorktreeChange: (dir: string) => void;
}

export interface FsWatchOptions {
  /** working-tree status の trailing-debounce 窓。テストで注入可能（production は 150ms）。
   * pure trailing-debounce のため、窓幅未満の間隔で鳴り続ける病的な継続 churn では発火が
   * 先送りされ続ける starvation edge を持つが、現実のファイル変更は必ず gap が空くため
   * 実害は薄い（max-wait cap は「sustained churn 中の定期 git status」を再導入するため
   * 意図的に入れない。Swift 版と同判断） */
  statusDebounceMs?: number;
  /** working-tree status の取得関数。テスト用 seam（production は gitStatusFull） */
  statusFetcher?: (dir: string) => Promise<StatusFull>;
  /** ファイル監視から除外する glob 一覧を返す（VS Code の `files.watcherExclude` 相当）。
   * subscribe を張り直すたびに読み、設定が変わっていれば working tree の root を新しい設定で
   * 張り直す。張り直しは watch / unwatch を契機に走るので、設定の変更は次の watch / unwatch で
   * 反映される。production は AppConfig の watcherExclude を渡す。省略時は除外なし（テスト用 default） */
  getWatcherExclude?: () => string[];
  /** native watcher への subscribe 経路（必須）。production は utilityProcess 隔離した
   * watcherClient、テストは callback を捕まえる偽物を渡す */
  transport: WatchTransport;
  /** watcher 実行時エラー等の診断を event-log へ流す。routes 側で `debugLog` push に変換する。
   * console.error は packaged で見えないため使わない。省略時は no-op（テスト用） */
  logEvent?: (channel: string, label: string, detail: string) => void;
}

interface Entry {
  generation: number;
  /** この entry が監視を要する root（dir と git dir の最小被覆）。registry が root ごとに subscribe する */
  roots: string[];
  /** `/fs/watch` で renderer から渡された原文の dir。push payload はこの値を返し、
   * renderer 側の `worktreeStore.dir` / `wt.path` 等の生文字列キーと直接比較できるようにする
   * （entries のキーは realpath 解決済み path で、event path の比較に使う） */
  originalDir: string;
  /** `git rev-parse --git-dir` の realpath。dir が git repo でない時のみ undefined */
  perWorktreeGitDir: string | undefined;
  /** `git rev-parse --git-common-dir` の realpath。通常 clone では perWorktreeGitDir と一致 */
  commonGitDir: string | undefined;
  /** 同一 resolved dir に対する watch 呼び出し回数。unwatch で 0 になった時点で entry を外し、
   * subscribe を張り直す。dialog + preview / 複数 leaf 等が同じ dir を並行 watch するケースで
   * 「片方の unwatch がもう片方の watch も解放する」破れを構造的に防ぐ */
  refCount: number;
}

const DEFAULT_STATUS_DEBOUNCE_MS = 150;

export function createFsWatchRegistry(handlers: FsWatchHandlers, options: FsWatchOptions) {
  const {
    statusDebounceMs = DEFAULT_STATUS_DEBOUNCE_MS,
    statusFetcher = gitStatusFull,
    getWatcherExclude = () => [],
    transport,
    logEvent = () => {},
  } = options;
  const { onFsChange, onGitStatusChange, onBranchChange, onRemoteRefsChange, onWorktreeChange } =
    handlers;

  const entries = new Map<string, Entry>();
  /** subscribe 済みの購読。キーは root と ignore の組（`subscriptionKey`）で、ignore が変われば
   * 別の購読として張り直す */
  const subscriptions = new Map<string, { root: string; ignore: string[]; handle: WatchHandle }>();
  /** 張り直しの列。並行した張り直しが互いの途中状態を見て、張れていない root を当てにしない */
  let reconcileTail: Promise<unknown> = Promise.resolve();
  /** watch 時の原文 dir → realpath 解決後のキー の逆引き。unwatch 時に dir が既に削除されて
   * いると realpath がフォールバックで入力 path を返し、watch 時のキーと一致せず entries が
   * leak するため、watch 時に解決した resolved key で確実に削除する */
  const resolvedKeyByOriginalDir = new Map<string, string>();
  /** commonGitDir → primary watcher の resolved dir。repo-scope event の dedup に使う。
   * 選出基準は main worktree（perWorktreeGitDir === commonGitDir）。gozd 配置 wt path が
   * main repo path より lex 小になるため「lex 最小」では wt が primary を奪い、
   * `.git/worktrees/<name>/` 単独削除の worktreeChange が silent drop する（Swift 版
   * `recomputePrimary` docstring 参照）。main worktree は `git worktree remove` で消せない
   * invariant も併せ持つため、発火元として常に生存する */
  const primaryByCommonGitDir = new Map<string, string>();
  /** commonGitDir → 直近に観測した ref digest。候補が立った primary watcher で内容比較し、
   * 実際に変化したカテゴリ（heads / remotes / head）だけを dispatch するためのキャッシュ。
   * 初回（key 不在）は無条件発火で renderer と baseline を合わせる */
  const lastRefDigestByCommonGitDir = new Map<string, RefDigest>();
  /** resolved dir → 直近に push 済みの StatusFull。内容不変の gitStatusChange 連射を止める
   * dedup キャッシュ。unwatch で破棄し、再 watch 後の最初の status は無条件 push させる */
  const lastPushedStatusByDir = new Map<string, StatusFull>();
  /** dir ごとの working-tree status trailing-debounce タイマー。新しい working-tree event の
   * 到着で先行タイマーをキャンセルし、最新リクエストだけを status 取得まで進める */
  const statusDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** status を取得中（admission の待機を含む）の dir。`startStatusRefresh` の single-flight 用 */
  const statusInFlightDirs = new Set<string>();
  /** 取得中に新しい要求が届いた dir。完了時に 1 回だけ取り直す */
  const statusRerunDirs = new Set<string>();
  /** 構築中（await gitDirs / subscribe 中）の同 dir 並行 watch を待たせる。entry の二重構築で
   * refCount と entry が上書きされるのを防ぐ */
  const pendingWatches = new Map<string, Promise<void>>();
  /** watch ごとに増える世代番号。unwatch 後に積まれていた stale event の dispatch を抑止する */
  let nextGeneration = 0;
  /** ユーザーが注視している dir（realpath 解決済み）。この dir の status は画面の要求と同じ
   * 優先度で取る。ファイラーの色分けやグラフの HEAD 追従が、他 worktree の status を待たない */
  let focusDir: string | undefined;

  /** realpath で symlink を解決した絶対パスを返す。解決失敗時は入力をそのまま返す
   * （FSEvents 由来の event path は realpath で届くため、`/var` と `/private/var` のような
   * symlink の差を吸収する。Swift 版と同じ判断） */
  function realpathOr(path: string): string {
    const result = tryCatch(() => realpathSync.native(path));
    return result.ok ? result.value : path;
  }

  function isActive(dir: string, generation: number): boolean {
    return entries.get(dir)?.generation === generation;
  }

  /** 包含される path を除いた最小被覆集合を返す。@parcel/watcher は再帰 watch なので、
   * 祖先 root の subscribe が子孫を覆う */
  function coveringRoots(paths: string[]): string[] {
    const unique = [...new Set(paths)];
    return unique.filter((path) => !unique.some((other) => isStrictlyUnder(path, other)));
  }

  /** dir 配下に入れ子で watch されている、同じ repo の別 worktree の root を返す。
   * repo 内に置かれた worktree（`.claude/worktrees/*` 等）の変更は、path を含む外側の entry にも
   * 振り分けられる。次のものは含めない:
   * - per-worktree git dir が同じもの: 同一作業ツリーのサブディレクトリで、変更が外側の status を変える
   * - common git dir が異なるもの: submodule は内部の変更が外側に gitlink の変更として現れる。
   *   別 repo の clone はこの条件だけでは submodule と区別できないため同じく含めない */
  function nestedWorktreeDirsOf(
    dir: string,
    perWorktreeGitDir: string | undefined,
    commonGitDir: string | undefined,
  ): string[] {
    if (commonGitDir === undefined) return [];
    const nested: string[] = [];
    for (const [key, entry] of entries) {
      if (!isStrictlyUnder(key, dir)) continue;
      if (entry.commonGitDir !== commonGitDir) continue;
      if (entry.perWorktreeGitDir === perWorktreeGitDir) continue;
      nested.push(key);
    }
    return nested;
  }

  /** primaryByCommonGitDir を該当 commonGitDir のグループに対して再計算する。
   * entry の追加 / 削除時に呼ぶ。グループに entry が残っていなければ map から消す */
  function recomputePrimary(commonGitDir: string): void {
    for (const [key, entry] of entries) {
      if (entry.commonGitDir !== commonGitDir) continue;
      if (entry.perWorktreeGitDir === commonGitDir) {
        primaryByCommonGitDir.set(commonGitDir, key);
        return;
      }
    }
    primaryByCommonGitDir.delete(commonGitDir);
    // primary が消えたら ref digest の baseline も破棄する。primary 不在の間は誰も digest を
    // 更新しないので、stale 値が次の primary 確立後の初回判定を誤らせるのを防ぐ
    lastRefDigestByCommonGitDir.delete(commonGitDir);
  }

  async function buildEntry(userDir: string, dir: string): Promise<void> {
    nextGeneration++;
    const generation = nextGeneration;

    // git dir を解決して監視 root に追加する。worktree では `.git` がファイル参照で、
    // commit / branch 更新の実体は親 repo 側にあるため、worktree root だけ watch しても
    // git 更新を取りこぼす。gitDirs は dir が git 管理下でない時のみ undefined（exit 128）。
    // それ以外の失敗（git バイナリ不在等）は throw して watch を中断させる。ここで握り潰すと
    // 「worktree なのに解決失敗」がサイレントに通常 watch にフォールバックし、commit が
    // 反映されない症状を再現してしまう
    const dirs = await gitDirs(dir);
    const perWorktreeGitDir = dirs === undefined ? undefined : realpathOr(dirs.perWorktreeGitDir);
    const commonGitDir = dirs === undefined ? undefined : realpathOr(dirs.commonGitDir);

    const roots = coveringRoots(
      [dir, perWorktreeGitDir, commonGitDir].filter((path): path is string => path !== undefined),
    );

    entries.set(dir, {
      generation,
      roots,
      originalDir: userDir,
      perWorktreeGitDir,
      commonGitDir,
      refCount: 1,
    });
    if (commonGitDir !== undefined) recomputePrimary(commonGitDir);
    const failures = await reconcileSubscriptions();
    // 自分の root を張れなかったときだけ watch を失敗させる。他の entry の root の失敗は
    // 張り直しが観察ログに残す
    const ownFailure = roots.map((root) => failures.get(root)).find((error) => error !== undefined);
    if (ownFailure !== undefined) {
      // 監視を張れなかった entry は登録しない。この entry のために張れた root は張り直しで外れる
      entries.delete(dir);
      if (commonGitDir !== undefined) recomputePrimary(commonGitDir);
      reconcileInBackground();
      throw ownFailure;
    }
    resolvedKeyByOriginalDir.set(userDir, dir);
    if (commonGitDir !== undefined) {
      // 登録の成立を再同期の起点にする。登録前からの状態と、subscribe の往復中に起きた変化を
      // 1 回の status で拾う
      scheduleStatusRefresh(dir, generation, userDir);
    }
  }

  /** 張るべき root。全 entry の root をそれぞれ張る */
  function desiredRoots(): string[] {
    // 含まれる側を先に張るため、長い root から並べる
    return [...new Set([...entries.values()].flatMap((entry) => entry.roots))].sort(
      (a, b) => b.length - a.length,
    );
  }

  /** root の購読に渡す ignore。
   *
   * - exclude は working-tree 由来の高churn（node_modules / build 等）を抑える設定だが、git dir を
   *   root とする購読に掛けると ref/HEAD/index の event を落として branch / status の検知が壊れる。
   *   git dir の root には掛けず、working tree の root にだけ掛ける
   * - root が別の root を含むときは、含む側の ignore に含まれる側の絶対パスを加え、含まれる側の
   *   event は含まれる側の購読だけが運ぶ。加えるのは張れている内側の root だけで、張れていない
   *   内側は含む側が覆ったままにし、event を落とさない（二重配送は残る） */
  function desiredIgnore(root: string, roots: string[]): string[] {
    const isGitDirRoot = [...entries.values()].some(
      (entry) => entry.perWorktreeGitDir === root || entry.commonGitDir === root,
    );
    const subscribedRoots = new Set(
      [...subscriptions.values()].map((subscribed) => subscribed.root),
    );
    const innerRoots = roots.filter(
      (other) => isStrictlyUnder(other, root) && subscribedRoots.has(other),
    );
    return [...(isGitDirRoot ? [] : getWatcherExclude()), ...innerRoots];
  }

  /** subscribe を desiredRoots と desiredIgnore が決める購読に合わせる。張り直しは列に並べて 1 本ずつ走らせる。
   * 返り値は張れなかった root と、その原因 */
  function reconcileSubscriptions(): Promise<Map<string, unknown>> {
    const run = reconcileTail.then(reconcileOnce);
    // 1 回の失敗で列が止まらないよう、列には結果だけを残す
    reconcileTail = tryCatch(run);
    return run;
  }

  /** 呼び出し元が完了を待たない張り直し。張れなかった root は reconcileOnce が観察ログに残す */
  function reconcileInBackground(): void {
    void tryCatch(reconcileSubscriptions()).then((result) => {
      if (!result.ok) {
        console.error(`[FSWatchRegistry] resubscribe failed: ${String(result.error)}`);
      }
    });
  }

  /** 足りない購読を先に張ってから、要らなくなった購読を外す。同じ root の購読を ignore の違いで
   * 張り替えるときも、新しい購読が張れてから古い購読を外すので、監視が途切れない。含まれる側を
   * 先に張り、含む側の ignore はその時点で張れた内側の root から決める */
  async function reconcileOnce(): Promise<Map<string, unknown>> {
    const failures = new Map<string, unknown>();
    const roots = desiredRoots();
    for (const root of roots) {
      const ignore = desiredIgnore(root, roots);
      const key = subscriptionKey(root, ignore);
      if (subscriptions.has(key)) continue;
      const subscribed = await tryCatch(
        transport.subscribe(root, ignore, dispatchEvents, (message) => {
          // packaged で見えない console.error でなく event-log に出す（crash 観測と観察面を揃える）
          logEvent("file-watcher", "watch-error", `${root}: ${message}`);
        }),
      );
      if (!subscribed.ok) {
        failures.set(root, subscribed.error);
        logEvent("file-watcher", "subscribe-failed", `${root}: ${String(subscribed.error)}`);
        continue;
      }
      subscriptions.set(key, { root, ignore, handle: subscribed.value });
    }
    // 外すかどうかは張り終えた時点の entry で決める。張っている間に entry が増減していれば、
    // その変化は列の次の張り直しが反映する
    const kept = keptSubscriptionKeys();
    for (const [key, { root, handle }] of subscriptions) {
      if (kept.has(key)) continue;
      subscriptions.delete(key);
      // unsubscribe は async だが完了を待つ必要はない。失敗だけ観察可能にする
      handle.unsubscribe().catch((error: unknown) => {
        console.error(`[FSWatchRegistry] unsubscribe failed for ${root}: ${String(error)}`);
      });
    }
    return failures;
  }

  /** 張り直しの後に残す購読。張るべき購読そのものと、張るべき購読がまだ張れていない root の
   * 古い購読を残す。さらに、残す購読が ignore している root の購読も残す — 外すとその root の中を
   * どの購読も運ばなくなる。その root を ignore しない購読に張り替わった後の張り直しで外れる */
  function keptSubscriptionKeys(): Set<string> {
    const roots = desiredRoots();
    const desiredKeys = new Map(
      roots.map((root) => [root, subscriptionKey(root, desiredIgnore(root, roots))]),
    );
    const kept = new Set(
      [...subscriptions]
        .filter(([key, { root }]) => {
          const desiredKey = desiredKeys.get(root);
          return desiredKey !== undefined && (desiredKey === key || !subscriptions.has(desiredKey));
        })
        .map(([key]) => key),
    );
    return withIgnoredRoots(kept);
  }

  /** kept の購読が ignore している root の購読を、増えなくなるまで kept に加える */
  function withIgnoredRoots(kept: Set<string>): Set<string> {
    const ignored = new Set([...kept].flatMap((key) => subscriptions.get(key)?.ignore ?? []));
    const added = [...subscriptions]
      .filter(([key, { root }]) => !kept.has(key) && ignored.has(root))
      .map(([key]) => key);
    if (added.length === 0) return kept;
    return withIgnoredRoots(new Set([...kept, ...added]));
  }

  /** 1 本の subscription に届いた event を、path を含む entry ごとに振り分ける */
  function dispatchEvents(paths: string[]): void {
    for (const [dir, entry] of entries) {
      const own = paths.filter((path) =>
        entry.roots.some((root) => relativeUnder(path, root) !== undefined),
      );
      if (own.length > 0) void handleEvents(dir, entry.generation, own);
    }
  }

  /** dir の監視を開始する。同一 resolved dir に対する watch は冪等で refCount を 1 増やす
   * だけ。最初の購読者で実際の watcher を構築する。renderer 側は 1 購読 = 1 watch /
   * 1 unwatch のペアを守る前提。`git worktree repair` 等で git dir 解決値が変わったケースの
   * 再構築は呼び出し側の責務（明示的に unwatch → watch）とする */
  async function watch(userDir: string): Promise<void> {
    const dir = realpathOr(userDir);
    // 構築中なら完了を待ってから refCount 経路へ（失敗していたら自分が構築し直す）
    let pending = pendingWatches.get(dir);
    while (pending !== undefined) {
      await tryCatch(pending);
      pending = pendingWatches.get(dir);
    }
    const existing = entries.get(dir);
    if (existing !== undefined) {
      existing.refCount++;
      resolvedKeyByOriginalDir.set(userDir, dir);
      // 購読者が増えたときも登録の成立として status を届け直す。renderer を作り直すと
      // 既存の entry に watch が重なるだけで、新しい renderer は status を持たないため、
      // 内容が直近の push と同じでも送る
      if (existing.commonGitDir !== undefined) {
        lastPushedStatusByDir.delete(dir);
        scheduleStatusRefresh(dir, existing.generation, existing.originalDir);
      }
      return;
    }
    const building = buildEntry(userDir, dir);
    pendingWatches.set(dir, building);
    const result = await tryCatch(building);
    pendingWatches.delete(dir);
    if (!result.ok) throw result.error;
  }

  /** dir の監視を停止する。watch されていなければ no-op。refCount を 1 減らし、0 になった
   * 時点で entry を外し、subscribe を残った entry に合わせて張り直す。張り直しが済むと
   * resolve する。張り直せなかった root は観察ログに残り、その root の古い購読は残る */
  async function unwatch(userDir: string): Promise<void> {
    const resolvedKey = resolvedKeyByOriginalDir.get(userDir) ?? realpathOr(userDir);
    const entry = entries.get(resolvedKey);
    if (entry === undefined) {
      resolvedKeyByOriginalDir.delete(userDir);
      return;
    }
    entry.refCount--;
    // 逆引きは entry の lifecycle に揃え、最終購読者の unwatch で unwatchResolved が
    // まとめて消す。ここで早期削除すると、次回 unwatch 時に realpath フォールバックに頼る
    // ことになり、dir 削除済み環境で resolved key が一致せず entry leak の race を開く
    if (entry.refCount > 0) return;
    unwatchResolved(resolvedKey);
    await reconcileSubscriptions();
  }

  /** 保持している全 entry の監視を一括停止する。renderer の onUnmounted / app teardown 用の
   * 構造的 cleanup 経路。個別 unwatch と異なり refCount に関わらず全 entry を強制解放する。
   * 全購読の解放を始めると、実際に破棄した entry 数（観察可能性用）で resolve する。native 側の
   * 解放の完了は待たない */
  async function unwatchAll(): Promise<number> {
    const dirs = [...entries.keys()];
    for (const dir of dirs) {
      unwatchResolved(dir);
    }
    await reconcileSubscriptions();
    return dirs.length;
  }

  /** entry と、その dir に紐づく状態を外す。subscribe の張り直しは呼び出し側が行う */
  function unwatchResolved(dir: string): void {
    const entry = entries.get(dir);
    if (entry === undefined) return;
    entries.delete(dir);
    // dedup キャッシュも掃除する。再 watch 後の最初の status を無条件 push させ、dir 削除後の
    // 別 repo 再配置などで stale 値が次の push を握り潰すのを防ぐ
    lastPushedStatusByDir.delete(dir);
    const timer = statusDebounceTimers.get(dir);
    if (timer !== undefined) clearTimeout(timer);
    statusDebounceTimers.delete(dir);
    // 取得中の git は止められないため in-flight 印は完了時に外れる。取り直しの印だけ消す
    statusRerunDirs.delete(dir);
    // 同一 resolved dir を指していた他の userDir 逆引きも掃除する（symlink パスと非 symlink
    // パスで watch が重ねられた状態で片方しか unwatch されないと逆引きが leak するため）
    for (const [orig, resolved] of resolvedKeyByOriginalDir) {
      if (resolved === dir) resolvedKeyByOriginalDir.delete(orig);
    }
    if (entry.commonGitDir !== undefined) {
      recomputePrimary(entry.commonGitDir);
    }
  }

  /** 1 バッチの event paths を分類して push handler に配送する。await 後にも isActive を
   * 再チェックし、unwatch 済み世代からの dispatch を抑止する */
  async function handleEvents(dir: string, generation: number, paths: string[]): Promise<void> {
    if (!isActive(dir, generation)) return;
    const entry = entries.get(dir);
    if (entry === undefined) return;
    const { originalDir, perWorktreeGitDir, commonGitDir } = entry;

    const result = classify({
      dir,
      perWorktreeGitDir,
      commonGitDir,
      nestedWorktreeDirs: nestedWorktreeDirsOf(dir, perWorktreeGitDir, commonGitDir),
      paths,
    });

    if (result.hasFsChange) {
      for (const relDir of result.fsRelDirs) {
        onFsChange(originalDir, relDir);
      }
    }

    const isPrimaryForCommonDir =
      commonGitDir !== undefined && primaryByCommonGitDir.get(commonGitDir) === dir;
    // primary watcher 未確立で repo-scope event が立つと silent drop に陥る。renderer は
    // repo を開いた時点で main worktree も登録するため通常運用では発生しないが、startup race /
    // bare repo / 部分登録で起こり得るため観察可能化する
    const hasRepoScopeCandidate =
      result.hasBranchChange ||
      result.hasRemoteRefsChange ||
      result.hasWorktreeChange ||
      result.hasHeadChange;
    if (
      hasRepoScopeCandidate &&
      !isPrimaryForCommonDir &&
      commonGitDir !== undefined &&
      !primaryByCommonGitDir.has(commonGitDir)
    ) {
      const siblings = [...entries.entries()]
        .filter(([, e]) => e.commonGitDir === commonGitDir)
        .map(([key, e]) => `${key}(main=${e.perWorktreeGitDir === commonGitDir})`)
        .sort();
      console.error(
        `[FSWatchRegistry] primary missing for commonGitDir=${commonGitDir}; dropping branchChange=${result.hasBranchChange} remoteRefsChange=${result.hasRemoteRefsChange} worktreeChange=${result.hasWorktreeChange} headChange=${result.hasHeadChange} from dir=${dir}; entries=${siblings.join(",")}`,
      );
    }

    // 構造変化由来の worktreeChange: `worktrees/*` の追加 / 削除、および secondary worktree
    // 自身の branch 切替。worktree list の構成変化を表す path 信号で、digest を経由せず即
    // dispatch する（main worktree の branch 切替は下の digest gating の head カテゴリが担う）
    if (result.hasWorktreeChange && isPrimaryForCommonDir) {
      onWorktreeChange(originalDir);
    }

    // branchChange / remoteRefsChange / worktreeChange(head) の digest gating。
    // 実際に heads / remotes / head のどれが動いたかを内容比較で確定する（classify.ts 冒頭参照）
    if (
      (result.hasBranchChange || result.hasRemoteRefsChange || result.hasHeadChange) &&
      isPrimaryForCommonDir &&
      commonGitDir !== undefined
    ) {
      const digestResult = await tryCatch(refDigest(dir));
      // refDigest の await 中に unwatch されている可能性があるため再チェック
      if (!isActive(dir, generation)) return;
      if (digestResult.ok) {
        const digest = digestResult.value;
        const prev = lastRefDigestByCommonGitDir.get(commonGitDir);
        lastRefDigestByCommonGitDir.set(commonGitDir, digest);
        // 初回（prev 不在）は baseline が無いので無条件発火し renderer と整合を取る
        if (result.hasBranchChange && prev?.heads !== digest.heads) {
          onBranchChange(originalDir);
        }
        if (result.hasRemoteRefsChange && prev?.remotes !== digest.remotes) {
          onRemoteRefsChange(originalDir);
        }
        // head (symbolic-ref 先) が変われば branch 切替 → worktree list の branch 出力が
        // 変わるため worktreeChange で list refetch させる。commit は head を変えない
        // （heads の OID だけ進む）ので誤発火しない
        if (result.hasHeadChange && prev?.head !== digest.head) {
          onWorktreeChange(originalDir);
        }
      } else {
        console.error(`[FSWatchRegistry] refDigest failed for ${dir}: ${digestResult.error}`);
        // digest 取得失敗時の fallback。local-cheap signal を撃って取りこぼしを防ぎ、
        // gh spam の元 remoteRefsChange だけは撃たない:
        // - branchChange は候補種別に関係なく撃つ（remote-only batch でも loadLog の唯一の
        //   回収経路。consumer は local のみで安価）
        // - hasHeadChange 候補は worktreeChange を撃って branch label を回収する
        // - remoteRefsChange の consumer `loadPrList` は 60s polling で回収される
        onBranchChange(originalDir);
        if (result.hasHeadChange) {
          onWorktreeChange(originalDir);
        }
      }
    }

    if (result.hasGitStatusChange) {
      // working-tree 由来の status 再取得は即時実行せず trailing-debounce に集約する。
      // ここで await すると checkout 終盤の ref 系 dispatch が working tree 書き換え量に
      // 従属して遅延する（issue #809）
      scheduleStatusRefresh(dir, generation, originalDir);
    }
  }

  function scheduleStatusRefresh(dir: string, watchGeneration: number, originalDir: string): void {
    const existing = statusDebounceTimers.get(dir);
    if (existing !== undefined) clearTimeout(existing);
    // trailing-debounce: 窓の間に新 event が来れば先行タイマーがキャンセルされ、
    // 最新リクエストだけが窓を生き延びて status を取る
    statusDebounceTimers.set(
      dir,
      setTimeout(() => {
        statusDebounceTimers.delete(dir);
        startStatusRefresh(dir, watchGeneration, originalDir);
      }, statusDebounceMs),
    );
  }

  /** dir ごとに status の取得を 1 本に絞る。取得は admission の枠を待つことがあり、その間に
   * 届いた要求まで起動すると、同じ作業ツリーの走査が枠の数だけ積み上がる。実行中（待機中を
   * 含む）に届いた要求は印だけ付け、完了後に最新の entry で 1 回だけ取り直す。取得は直列なので、
   * 古い取得の結果が新しい取得の結果を上書きすることは起きない */
  function startStatusRefresh(dir: string, watchGeneration: number, originalDir: string): void {
    if (statusInFlightDirs.has(dir)) {
      statusRerunDirs.add(dir);
      return;
    }
    statusInFlightDirs.add(dir);
    void (async () => {
      const result = await tryCatch(runStatusRefresh(dir, watchGeneration, originalDir));
      // 失敗しても印は必ず外す。残るとこの dir の status が二度と取られない
      statusInFlightDirs.delete(dir);
      if (!result.ok) {
        console.error(`[FSWatchRegistry] status refresh failed for ${dir}: ${result.error}`);
      }
      if (!statusRerunDirs.delete(dir)) return;
      // unwatch → 再 watch をまたいだ要求を落とさないよう、世代は現在の entry から読み直す
      const entry = entries.get(dir);
      if (entry === undefined) return;
      startStatusRefresh(dir, entry.generation, entry.originalDir);
    })();
  }

  /** git status を実行し、内容が変わっていれば push する。await 前後で watch 世代を確かめ、
   * unwatch / 再 watch 後に古い watch の結果を push しない */
  async function runStatusRefresh(
    dir: string,
    watchGeneration: number,
    originalDir: string,
  ): Promise<void> {
    if (!isActive(dir, watchGeneration)) return;
    // 監視起点の status は、注視中の dir 以外は画面の要求より後回しにしてよい。worktree の数だけ
    // 並ぶため、interactive と同じ枠で走らせると git log や注視中の dir の status を待たせる
    const tier = dir === focusDir ? "interactive" : "background";
    const result = await tryCatch(withGitTier(tier, () => statusFetcher(dir)));
    if (!result.ok) {
      // 観察可能性のためログを残す。renderer は次の event バッチで再 fetch するため
      // 致命的ではないが、繰り返し発生していれば一時障害として診断したい
      console.error(`[FSWatchRegistry] gitStatusFull failed for ${dir}: ${result.error}`);
      return;
    }
    if (!isActive(dir, watchGeneration)) return;
    const status = result.value;
    // 内容が直近 push と同一なら push しない（gitignore 対象の書き込み連射を止める）
    const last = lastPushedStatusByDir.get(dir);
    if (last !== undefined && statusEquals(last, status)) return;
    lastPushedStatusByDir.set(dir, status);
    onGitStatusChange(originalDir, status);
  }

  /** 注視中の dir を差し替える。undefined は注視先なし。取得を始める時点の値で優先度が決まる */
  function setFocusDir(userDir: string | undefined): void {
    focusDir = userDir === undefined ? undefined : realpathOr(userDir);
  }

  return { watch, unwatch, unwatchAll, setFocusDir };
}

/** path が root の配下にあるか（root 自身は含まない） */
function isStrictlyUnder(path: string, root: string): boolean {
  const relative = relativeUnder(path, root);
  return relative !== undefined && relative !== "";
}

/** 購読の同一性。同じ root でも ignore が違えば別の購読として張り直す */
function subscriptionKey(root: string, ignore: string[]): string {
  return JSON.stringify([root, ignore]);
}

/** StatusFull の内容等値比較。Swift 版は Equatable 導出に相当 */
function statusEquals(a: StatusFull, b: StatusFull): boolean {
  return (
    a.head === b.head &&
    a.branchHead === b.branchHead &&
    a.hasUpstream === b.hasUpstream &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.latestMtime === b.latestMtime &&
    recordEquals(a.statuses, b.statuses) &&
    recordEquals(a.renameOldPaths, b.renameOldPaths)
  );
}

function recordEquals(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}
