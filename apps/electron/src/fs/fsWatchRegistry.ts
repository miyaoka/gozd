// dir 単位でファイル監視を保持し、再帰的なファイル変更を push event に振り分ける registry。
// Swift 版 `FSWatchRegistry.swift`（actor）の対応物。分類の設計判断は `classify.ts` 冒頭を参照。
//
// Swift 版との構造差分:
//
// - **FSEvents stream → @parcel/watcher subscription**。Swift は 1 stream に
//   [worktree root, per-worktree git dir, common git dir] の複数 root を登録できるが、
//   @parcel/watcher は 1 subscribe = 1 root。包含する root を重ねて subscribe すると同一
//   event が二重配送されるため、包含される path を除いた最小被覆集合だけ subscribe する
//   （通常 clone: `.git` は root 配下 → 1 本。worktree: per-wt git dir は common 配下 →
//   [worktree root, common git dir] の 2 本）。
// - **actor → 素の closure state**。Node はシングルスレッドで排他は不要だが、await
//   （gitDirs 解決 / refDigest / git status）を跨ぐ間に unwatch や後続 event が割り込む
//   構造は同じなので、watch 世代 + status リクエスト世代の二重チェックはそのまま移植する。
// - **構築中の同 dir 並行 watch は pendingWatches で直列化**。Swift actor にも
//   `await gitDirs` 中の reentrancy 窓（entry 二重構築 → 先行 stream leak）があるが、
//   こちらは構築 promise を待たせて構造的に塞ぐ。
//
// 主要な設計判断（Swift 版から継承）:
//
// - **push の重複は許容**。renderer 側は冪等な再 fetch で受け止める。
// - **branchChange / remoteRefsChange / head 由来 worktreeChange は digest gating**。
//   path 分類は「ref store が動いた候補」までしか分からず（reftable backend は local /
//   remote / HEAD が 1 テーブルに同居）、candidate が立った primary watcher で
//   `refDigest` を読み、前回値と差があるカテゴリだけ dispatch する。これが無いと commit の
//   たびに remoteRefsChange が飛び、renderer の `gh pr list` が GitHub rate limit を食い潰す。
// - **repo-scope event は primary watcher（main worktree）1 つに collapse**。同 repo を
//   共有する N worktree の watcher が同じ common git dir event で同時発火するため。
// - **working-tree 由来の git status は trailing-debounce**。checkout flood の N バッチを
//   最新 1 回の status 取得に畳む（issue #809）。branch label は ref 系経路が即時駆動する。
// - **内容不変の gitStatusChange は dedup**。gitignore 対象（ビルド成果物等）の書き込みは
//   作業ツリー event として候補が立つが git status 出力は不変のため、直近 push 値と一致する
//   間は push しない。

import { subscribe, type AsyncSubscription, type SubscribeCallback } from "@parcel/watcher";
import { tryCatch } from "@gozd/shared";
import { realpathSync } from "node:fs";
import { gitDirs, gitStatusFull, refDigest, type RefDigest } from "../git/gitOps";
import type { StatusFull } from "../git/porcelain";
import { classify } from "./classify";

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
}

interface Entry {
  generation: number;
  subscriptions: AsyncSubscription[];
  /** `/fs/watch` で renderer から渡された原文の dir。push payload はこの値を返し、
   * renderer 側の `worktreeStore.dir` / `wt.path` 等の生文字列キーと直接比較できるようにする
   * （entries のキーは realpath 解決済み path で、event path の比較に使う） */
  originalDir: string;
  /** `git rev-parse --git-dir` の realpath。dir が git repo でない時のみ undefined */
  perWorktreeGitDir: string | undefined;
  /** `git rev-parse --git-common-dir` の realpath。通常 clone では perWorktreeGitDir と一致 */
  commonGitDir: string | undefined;
  /** 同一 resolved dir に対する watch 呼び出し回数。unwatch で 0 になった時点で実 watcher を
   * 停止する。dialog + preview / 複数 leaf 等が同じ dir を並行 watch するケースで「片方の
   * unwatch がもう片方の watch も解放する」破れを構造的に防ぐ */
  refCount: number;
}

const DEFAULT_STATUS_DEBOUNCE_MS = 150;

export function createFsWatchRegistry(handlers: FsWatchHandlers, options: FsWatchOptions = {}) {
  const {
    statusDebounceMs = DEFAULT_STATUS_DEBOUNCE_MS,
    statusFetcher = gitStatusFull,
  } = options;
  const { onFsChange, onGitStatusChange, onBranchChange, onRemoteRefsChange, onWorktreeChange } =
    handlers;

  const entries = new Map<string, Entry>();
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
  /** dir ごとの status リクエスト世代。in-flight の git status は Node ではキャンセルできない
   * ため、await 前後で「自分が最新リクエストか」を再チェックし、古い in-flight が新しい結果を
   * 上書きするのを弾く（watch 世代とは独立。同一 watch 内での request 順序を守る軸） */
  const statusRequestGenerationByDir = new Map<string, number>();
  /** 構築中（await gitDirs / subscribe 中）の同 dir 並行 watch を待たせる。二重構築による
   * 先行 subscription の leak を防ぐ */
  const pendingWatches = new Map<string, Promise<void>>();
  /** watch ごとに増える世代番号。unwatch 後に積まれていた stale event の dispatch を抑止する */
  let nextGeneration = 0;

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
    return unique.filter((path) => {
      return !unique.some((other) => {
        if (other === path) return false;
        const otherWithSlash = other.endsWith("/") ? other : `${other}/`;
        return path.startsWith(otherWithSlash);
      });
    });
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

    const candidates = [dir, perWorktreeGitDir, commonGitDir].filter(
      (path): path is string => path !== undefined,
    );
    const watchRoots = coveringRoots(candidates);

    const callback: SubscribeCallback = (err, events) => {
      if (err !== null) {
        console.error(`[FSWatchRegistry] watcher error for ${dir}: ${err}`);
        return;
      }
      void handleEvents(
        dir,
        generation,
        events.map((event) => event.path),
      );
    };

    const subscriptions: AsyncSubscription[] = [];
    for (const root of watchRoots) {
      const sub = await tryCatch(subscribe(root, callback));
      if (!sub.ok) {
        // 部分成功のまま throw すると成功済み subscription が leak するため巻き戻す
        for (const succeeded of subscriptions) {
          void succeeded.unsubscribe();
        }
        throw sub.error;
      }
      subscriptions.push(sub.value);
    }

    entries.set(dir, {
      generation,
      subscriptions,
      originalDir: userDir,
      perWorktreeGitDir,
      commonGitDir,
      refCount: 1,
    });
    resolvedKeyByOriginalDir.set(userDir, dir);
    if (commonGitDir !== undefined) {
      recomputePrimary(commonGitDir);
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
      return;
    }
    const building = buildEntry(userDir, dir);
    pendingWatches.set(dir, building);
    const result = await tryCatch(building);
    pendingWatches.delete(dir);
    if (!result.ok) throw result.error;
  }

  /** dir の監視を停止する。watch されていなければ no-op。refCount を 1 減らし、0 になった
   * 時点で実 watcher を停止する */
  function unwatch(userDir: string): void {
    const resolvedKey = resolvedKeyByOriginalDir.get(userDir) ?? realpathOr(userDir);
    const entry = entries.get(resolvedKey);
    if (entry === undefined) {
      resolvedKeyByOriginalDir.delete(userDir);
      return;
    }
    entry.refCount--;
    if (entry.refCount <= 0) {
      unwatchResolved(resolvedKey);
    }
    // 逆引きは entry の lifecycle に揃え、最終購読者の unwatch で unwatchResolved が
    // まとめて消す。ここで早期削除すると、次回 unwatch 時に realpath フォールバックに頼る
    // ことになり、dir 削除済み環境で resolved key が一致せず entry leak の race を開く
  }

  /** 保持している全 entry の監視を一括停止する。renderer の onUnmounted / app teardown 用の
   * 構造的 cleanup 経路。個別 unwatch と異なり refCount に関わらず全 entry を強制解放する。
   * 返り値は実際に破棄した entry 数（観察可能性用） */
  function unwatchAll(): number {
    const dirs = [...entries.keys()];
    for (const dir of dirs) {
      unwatchResolved(dir);
    }
    return dirs.length;
  }

  function unwatchResolved(dir: string): void {
    const entry = entries.get(dir);
    if (entry === undefined) return;
    entries.delete(dir);
    for (const sub of entry.subscriptions) {
      // unsubscribe は async だが完了を待つ必要はない。失敗だけ観察可能にする
      sub.unsubscribe().catch((error: unknown) => {
        console.error(`[FSWatchRegistry] unsubscribe failed for ${dir}: ${error}`);
      });
    }
    // dedup キャッシュも掃除する。再 watch 後の最初の status を無条件 push させ、dir 削除後の
    // 別 repo 再配置などで stale 値が次の push を握り潰すのを防ぐ
    lastPushedStatusByDir.delete(dir);
    const timer = statusDebounceTimers.get(dir);
    if (timer !== undefined) clearTimeout(timer);
    statusDebounceTimers.delete(dir);
    statusRequestGenerationByDir.delete(dir);
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

    const result = classify({ dir, perWorktreeGitDir, commonGitDir, paths });

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
    const requestGeneration = (statusRequestGenerationByDir.get(dir) ?? 0) + 1;
    statusRequestGenerationByDir.set(dir, requestGeneration);
    const existing = statusDebounceTimers.get(dir);
    if (existing !== undefined) clearTimeout(existing);
    // trailing-debounce: 窓の間に新 event が来れば先行タイマーがキャンセルされ、
    // 最新リクエストだけが窓を生き延びて status を取る
    statusDebounceTimers.set(
      dir,
      setTimeout(() => {
        statusDebounceTimers.delete(dir);
        void runStatusRefresh(dir, watchGeneration, requestGeneration, originalDir);
      }, statusDebounceMs),
    );
  }

  /** debounce 窓を生き延びたリクエストの git status を実行し、最新であれば push する。
   * await 前後で watch 世代（unwatch / 再 watch）と request 世代（後続 event による新
   * リクエスト）の両方を再チェックし、古い in-flight status が新しい結果を上書きするのを防ぐ */
  async function runStatusRefresh(
    dir: string,
    watchGeneration: number,
    requestGeneration: number,
    originalDir: string,
  ): Promise<void> {
    if (!isActive(dir, watchGeneration)) return;
    if (statusRequestGenerationByDir.get(dir) !== requestGeneration) return;
    const result = await tryCatch(statusFetcher(dir));
    if (!result.ok) {
      // 観察可能性のためログを残す。renderer は次の event バッチで再 fetch するため
      // 致命的ではないが、繰り返し発生していれば一時障害として診断したい
      console.error(`[FSWatchRegistry] gitStatusFull failed for ${dir}: ${result.error}`);
      return;
    }
    if (!isActive(dir, watchGeneration)) return;
    if (statusRequestGenerationByDir.get(dir) !== requestGeneration) return;
    const status = result.value;
    // 内容が直近 push と同一なら push しない（gitignore 対象の書き込み連射を止める）
    const last = lastPushedStatusByDir.get(dir);
    if (last !== undefined && statusEquals(last, status)) return;
    lastPushedStatusByDir.set(dir, status);
    onGitStatusChange(originalDir, status);
  }

  return { watch, unwatch, unwatchAll };
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
