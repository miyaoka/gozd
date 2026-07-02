/**
 * Preview の content 取得層。PreviewPane から「何をどこから読んで表示するか」の状態機械を
 * 分離した composable。表示 leaf の切替 (template) と編集 / blame の文脈導出は本層の
 * 戻り値を入力にする。
 *
 * ## 所有する状態
 *
 * - 取得結果 (current / original の content と binary 判定、loading / error / notFound)
 * - 表示モード (`activeMode`) と Preview トグル (`previewEnabled`): fetch 結果からデフォルトを
 *   導出して書き換えるのは本層だけなので、UI 状態だがここに置く
 * - `contentEpoch`: main watch が発火するたびに増えるカウンタ。「content が変わる (かもしれない)
 *   すべての瞬間」を 1 本の ref に畳み、popover close 側 (`usePreviewRevs`) の watch deps を
 *   本層の deps リストと手動同期させる必要をなくす (deps 二重管理による drift を構造的に防ぐ)
 *
 * ## データ取得の 3 経路
 *
 * - Uncommitted モード: ファイル選択・git status 変化時に current（ファイルシステム）/
 *   original（HEAD）を並列取得。rename (move) されたファイルは HEAD 側に新パスが存在しないため、
 *   original / 画像 Original タブは `useGitStatusStore.renameOldPaths`（新パス → 旧パス）で
 *   旧パスに解決してから引く
 * - コミットモード: git-graph の選択コミットに応じて gitShowCommitFile RPC で from/to を一括取得。
 *   範囲選択時は `orderCommitRange` で時系列順に整列し（クリック順非依存）、older 側を Original、
 *   newer 側を Current に固定する
 * - PR diff モード: from = merge-base blob (`rpcGitReadBlob`)、to = working tree
 *
 * fsChange メッセージで選択中ファイルをリアクティブに再取得（uncommitted / PR diff モードのみ）。
 * バージョンカウンターで非同期レースを防止する。
 */
import { tryCatch } from "@gozd/shared";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { useChangesStore, useChangesSummaryStore } from "../changes";
import { relDirOf, rpcFsReadFile, rpcFsReadFileAbsolute } from "../filer";
import type { FsChangePayload } from "../filer";
import { rpcGitReadBlob, useGitGraphStore, usePrDiffToggleStore } from "../git-graph";
import { UNCOMMITTED_HASH, useGitStatusStore, useWorktreeStore } from "../worktree";
import type { GitChangeKind, Selection } from "../worktree";
import { orderCommitRange } from "./commitRange";
import type { OrderedRange } from "./commitRange";
import { buildAbsFileServerUrl, buildFileServerUrl } from "./fileServerUrl";
import { defaultPreviewEnabled, detectFileType } from "./previewFileType";
import type { FileType } from "./previewFileType";
import { availableModesFor, defaultMode, hasGitDiff } from "./previewMode";
import type { PreviewMode } from "./previewMode";
import { rpcGitShowCommitFile, rpcGitShowFile } from "./rpc";
import { shouldCloseForMissingFile } from "./shouldCloseForMissingFile";
import { usePreviewEditStore } from "./usePreviewEditStore";
import { usePreviewStore } from "./usePreviewStore";

const SHORT_HASH_LEN = 7;

export type PreviewContent = ReturnType<typeof usePreviewContent>;

export function usePreviewContent(
  options: {
    /**
     * fsChange 由来の再取得の直前に呼ばれる hook。content 更新で CodePreview / DiffPreview が
     * 再ハイライト・再描画し line-no button DOM が置換されるため、同 file に対して開いている
     * blame 系 popover を anchor detach 前に閉じる用途 (呼び出し側で `closeIfActive` を発射する)。
     * 本層は commit-history feature に依存しない。
     */
    onBeforeRefetch?: (dir: string, relPath: string) => void;
  } = {},
) {
  const worktreeStore = useWorktreeStore();
  const gitStatusStore = useGitStatusStore();
  const { selection, selectedDisplayPath, selectedRelPath, selectedGitChange } =
    storeToRefs(worktreeStore);
  const gitGraphStore = useGitGraphStore();
  const prDiffToggle = usePrDiffToggleStore();
  const summaryStore = useChangesSummaryStore();
  const changesStore = useChangesStore();
  const previewStore = usePreviewStore();
  const editStore = usePreviewEditStore();
  const notification = useNotificationStore();

  const currentContent = ref<string>();
  const originalContent = ref<string>();
  const isBinary = ref(false);
  const isOriginalBinary = ref(false);
  const loading = ref(false);
  const error = ref<string>();
  /** 選択パスがディレクトリの場合 true */
  const isDirectory = ref(false);
  /** 選択パスが存在しない場合 true */
  const isNotFound = ref(false);
  const activeMode = ref<PreviewMode>("current");

  /** Preview チェックボックス（SVG / Markdown / 画像 / HTML で使用） */
  const previewEnabled = ref(true);

  /** コミットモード時の変更種別（from/to の取得結果から導出） */
  const commitGitChange = ref<GitChangeKind>();

  /**
   * main watch の発火ごとに増えるカウンタ。「content が変わりうる瞬間」の観測点として
   * `usePreviewRevs` の popover close watcher が購読する。早期 return (editMode ガード等) より
   * 前に増やすことで、旧実装の「close watcher は content watch と同一 deps で無条件発火」と
   * 同じ発火集合を 1 本の ref で表現する。
   */
  const contentEpoch = ref(0);

  /** 実効的な変更種別（uncommitted モードでは git status、commit / PR diff モードでは取得結果から導出） */
  const effectiveGitChange = computed(() => {
    if (prDiffToggle.isOn) return commitGitChange.value;
    if (gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null) {
      return commitGitChange.value;
    }
    return selectedGitChange.value;
  });

  const fileType = computed<FileType>(() => {
    const path = selectedDisplayPath.value;
    if (path === undefined) return "code";
    return detectFileType(path);
  });

  /** 画像プレビュー表示中か（diff 不可のため モード制限に使用） */
  const isImagePreview = computed(() => {
    const ft = fileType.value;
    return (ft === "image" || ft === "svg") && previewEnabled.value;
  });

  /** 選択ファイルの変更状態に応じて利用可能なモード一覧 */
  const availableModes = computed<PreviewMode[]>(() =>
    availableModesFor(effectiveGitChange.value, isImagePreview.value),
  );

  /**
   * commit mode (single 単体 or 範囲) かを集約判定。
   * `orderedRange` の null 経路の分岐と、uncommitted 専用データ (`renameOldPaths`) の適用 gate に使う。
   */
  const isCommitMode = computed(
    () => gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null,
  );

  /** 範囲選択を時系列順に整列した {newer, older}。整列規約は `orderCommitRange` を参照 */
  const orderedRange = computed<OrderedRange | null>(() =>
    orderCommitRange(
      gitGraphStore.selectedHash,
      gitGraphStore.compareHash,
      gitGraphStore.hashToIndex,
    ),
  );

  /**
   * Original タブが指している hash の表記。
   * Swift 側 handleGitShowCommitFile の fromHash と一致させる:
   * - PR diff モード: PR base OID (^ なし)
   * - uncommitted モード (newer=Working Tree, older=undefined): HEAD
   * - 単一コミット: <hash>^
   * - 範囲選択: <older>^
   * - orderedRange が null（不整合）: undefined を返す。ラベル側で hash 表記なしに倒し、
   *   実際には参照していない HEAD などの虚偽情報をラベルに出さない。
   */
  const originalHashLabel = computed<string | undefined>(() => {
    if (prDiffToggle.isOn) {
      const oid = prDiffToggle.lockedBaseOid;
      return oid === undefined ? undefined : oid.slice(0, SHORT_HASH_LEN);
    }
    const range = orderedRange.value;
    if (range === null) return undefined;
    const { newer, older } = range;
    if (newer === UNCOMMITTED_HASH && older === undefined) return "HEAD";
    const olderEnd = older ?? newer;
    return `${olderEnd.slice(0, SHORT_HASH_LEN)}^`;
  });

  /** 非同期レース防止 + 画像キャッシュバスト用のバージョンカウンター */
  const fetchVersionRef = ref(0);
  let fetchVersion = 0;

  /** ファイル内容を取得する（watch と fsChange から共用） */
  async function fetchContent(sel: Selection, gitChange: GitChangeKind | undefined) {
    loading.value = true;
    error.value = undefined;
    isDirectory.value = false;
    isNotFound.value = false;

    const version = ++fetchVersion;
    fetchVersionRef.value = version;

    const isDeleted = gitChange === "deleted";
    const hasDiff = hasGitDiff(gitChange);

    const dir = worktreeStore.dir;
    // await 前の同期パス: version === fetchVersion 保証のため version ガード不要。
    if (dir === undefined) {
      loading.value = false;
      return;
    }

    // 並列でデータ取得。worktreeRelative は fsReadFile + git show を、
    // absolute は fsReadFileAbsolute 単独を呼ぶ (worktree 外は git 履歴を持たない)。
    const currentPromise = isDeleted
      ? Promise.resolve(undefined)
      : sel.kind === "absolute"
        ? rpcFsReadFileAbsolute({ absolutePath: sel.absPath }).then((r) => r.result)
        : rpcFsReadFile({ dir, path: sel.relPath }).then((r) => ({
            content: r.content,
            isBinary: r.isBinary,
            isDirectory: r.isDirectory,
            notFound: r.notFound,
          }));
    // rename (move) されたファイルは HEAD 側に新パスが存在しない。比較元は旧パスで引く。
    // 旧パス map は git status と同一 snapshot から来る SSOT (`gitStatusStore.renameOldPaths`)。
    const originalPromise =
      sel.kind === "worktreeRelative" && (hasDiff || isDeleted)
        ? rpcGitShowFile({
            dir,
            relPath: gitStatusStore.renameOldPaths[sel.relPath] ?? sel.relPath,
          }).then((r) => r.result)
        : Promise.resolve(undefined);
    const fetchResult = await tryCatch(Promise.all([currentPromise, originalPromise]));

    // 別の読み込みが開始された場合は結果を破棄
    if (version !== fetchVersion) return;

    if (!fetchResult.ok) {
      error.value = fetchResult.error.message;
      notification.error("Failed to read file", fetchResult.error);
      loading.value = false;
      return;
    }

    const [currentResult, originalResult] = fetchResult.value;

    // 表示中ファイルが消えたかの判定: current (作業ツリー) が notFound で HEAD にも内容が無いなら、
    // 「実体がどこにも残っていない」= 未追跡ファイルの削除等。選択解除して preview を閉じる。
    // 単一ファイル削除も親ディレクトリごとの削除も、同じ fsChange → 再 fetch → notFound 経路で拾う
    // (FSWatcher は FileEvents flag 付きで配下ファイル単位の削除イベントを出すため)。
    //
    // 閉じるかの論理判定 (summary / kind / current / HEAD) は shouldCloseForMissingFile に一本化する。
    // ここでは HEAD 在否確定の RPC を「撃つ価値がある最小条件」= summary 非表示 かつ worktreeRelative
    // かつ current notFound かつ未取得、のときだけ撃つ (無駄撃ち回避)。RPC ガードは純粋関数が閉じうる
    // 前提のうち副作用回避に効くものだけを写し、最終判定は純粋関数に委ねる。それ以外は HEAD 在否を
    // 見るまでもなく閉じないので originalMissing=false に倒す。
    const currentNotFound = currentResult?.notFound ?? false;
    let originalMissing: boolean;
    if (originalResult !== undefined) {
      originalMissing = originalResult.notFound;
    } else if (!summaryStore.enabled && currentNotFound && sel.kind === "worktreeRelative") {
      // original 未取得 (untracked / clean tracked) かつ current 消失。HEAD 在否を直接確定する。
      // git status の push が fsChange より遅れて selectedGitChange がまだ deleted に変わっていない
      // race でも、HEAD に在れば追跡下なので閉じない (直後の gitStatusChange が Original 表示へ倒す)。
      const head = await tryCatch(rpcGitShowFile({ dir, relPath: sel.relPath }));
      if (version !== fetchVersion) return;
      // native は HEAD 不在も git 実行失敗も notFound=true に畳んで返す (fileReadResultFromGit)。
      // よって HEAD 不在は head.ok===true && notFound===true で表現される。head.ok===false は
      // transport/dispatch 層の失敗のみで、不在を確定できないため閉じない (notFound 表示へ倒す)。
      originalMissing = head.ok ? (head.value.result?.notFound ?? false) : false;
    } else {
      // 閉じる候補でない (current 在 / 絶対パス) → HEAD を確定する必要がなく、不在ではない扱い
      originalMissing = false;
    }
    if (
      shouldCloseForMissingFile({
        summaryEnabled: summaryStore.enabled,
        selKind: sel.kind,
        currentNotFound,
        originalMissing,
      })
    ) {
      loading.value = false;
      previewStore.closeForMissingSelection();
      return;
    }

    isDirectory.value = currentResult?.isDirectory ?? false;
    isNotFound.value = currentResult?.notFound ?? false;

    if (currentResult !== undefined) {
      currentContent.value = currentResult.content;
      isBinary.value = currentResult.isBinary;
    } else {
      currentContent.value = undefined;
      isBinary.value = false;
    }
    if (originalResult !== undefined) {
      originalContent.value = originalResult.content;
      isOriginalBinary.value = originalResult.isBinary;
    } else {
      originalContent.value = undefined;
      isOriginalBinary.value = false;
    }

    loading.value = false;
  }

  /** コミットモード時のファイル内容取得 */
  async function fetchCommitContent(filePath: string) {
    loading.value = true;
    error.value = undefined;
    isDirectory.value = false;
    isNotFound.value = false;

    const version = ++fetchVersion;
    fetchVersionRef.value = version;

    // 以下 await 前の同期パス: version === fetchVersion が保証されているため version ガード不要。
    const dir = worktreeStore.dir;
    if (dir === undefined) {
      loading.value = false;
      return;
    }

    // クリック順に依存せず時系列で並べ替え: newer = current(to), older = original(from)
    const range = orderedRange.value;
    if (range === null) {
      error.value = "Commit selection is inconsistent with loaded git log";
      notification.error(error.value);
      loading.value = false;
      return;
    }
    const { newer, older } = range;

    // RPC 境界では UNCOMMITTED_HASH sentinel を流さず、wire 上は常に実 hash のみ扱う。
    // newer が Working Tree のときは to を filesystem から、from は <older>^ の内容を
    // gitShowCommitFile(hash=older, compareHash="") の from 結果として取得する。
    // 以下 throw は orderedRange の不変条件上ありえないケースの防御的観察可能化:
    // 到達したら tryCatch 経路で notification.error に上がる。
    const fetchResult = await tryCatch(
      (async () => {
        if (newer === UNCOMMITTED_HASH) {
          if (older === undefined) {
            throw new Error("commit mode with working tree newer requires an older endpoint");
          }
          const [showResult, fsResult] = await Promise.all([
            rpcGitShowCommitFile({
              dir,
              relPath: filePath,
              hash: older,
              compareHash: "",
            }),
            rpcFsReadFile({ dir, path: filePath }),
          ]);
          return {
            from: showResult.from,
            to: {
              content: fsResult.content,
              isBinary: fsResult.isBinary,
              notFound: fsResult.notFound,
            },
            // Working Tree との比較は git blob OID が無いので unchanged 判定なし。
            unchanged: false,
          };
        }
        const showResult = await rpcGitShowCommitFile({
          dir,
          relPath: filePath,
          hash: newer,
          compareHash: older ?? "",
        });
        return { from: showResult.from, to: showResult.to, unchanged: showResult.unchanged };
      })(),
    );

    if (version !== fetchVersion) return;

    if (!fetchResult.ok) {
      error.value = fetchResult.error.message;
      notification.error("Failed to read commit file", fetchResult.error);
      loading.value = false;
      return;
    }

    // unchanged は Swift 側で from と to の blob OID 比較から導出される SSOT 判定。
    // Filer 経由でコミット範囲外（差分のない）ファイルを選んだ場合の救済はここに寄せる。
    const { from, to, unchanged } = fetchResult.value;
    const fromNotFound = from?.notFound ?? true;
    const toNotFound = to?.notFound ?? true;

    if (fromNotFound && toNotFound) {
      commitGitChange.value = undefined;
    } else if (fromNotFound) {
      commitGitChange.value = "added";
    } else if (toNotFound) {
      commitGitChange.value = "deleted";
    } else if (unchanged) {
      commitGitChange.value = undefined;
    } else {
      commitGitChange.value = "modified";
    }

    if (commitGitChange.value === "deleted") {
      activeMode.value = "original";
    } else if (commitGitChange.value === "modified") {
      activeMode.value = "diff";
    } else {
      activeMode.value = "current";
    }

    originalContent.value = fromNotFound ? undefined : from?.content;
    isOriginalBinary.value = from?.isBinary ?? false;
    currentContent.value = toNotFound ? undefined : to?.content;
    isBinary.value = to?.isBinary ?? false;
    isNotFound.value = fromNotFound && toNotFound;

    loading.value = false;
  }

  /**
   * PR diff モード時のファイル内容取得。`merge-base(HEAD, baseRefOid)`..working tree の per-file diff。
   *
   * from = `prDiffToggle.lockedBaseOid` (= merge-base OID) の blob を `rpcGitReadBlob` で取得。
   * to = working tree の fs 内容。起点 OID の決定は `usePrDiffToggleStore.enable()` で済んでおり、
   * `lockedBaseOid` (= `lockedBase.diffBaseOid`) はそのままここで起点として使える。
   */
  async function fetchPrDiffContent(filePath: string) {
    loading.value = true;
    error.value = undefined;
    isDirectory.value = false;
    isNotFound.value = false;

    const version = ++fetchVersion;
    fetchVersionRef.value = version;

    const dir = worktreeStore.dir;
    if (dir === undefined) {
      loading.value = false;
      return;
    }
    const baseOid = prDiffToggle.lockedBaseOid;
    if (baseOid === undefined) {
      loading.value = false;
      return;
    }

    // `useChangesStore.orderedFileChanges` から該当 GitFileChange を引いて type ごとに正しい path を選ぶ:
    // - A / U (added / untracked): base にそのパスは存在しない → base fetch を skip
    // - D (deleted): working tree にそのパスは存在しない → fs read を skip
    // - R (renamed): base には `oldFilePath`、working tree には `newFilePath` で存在
    // - M (modified): 同パスで両方存在
    // この path 選択を欠くと「存在しないパスへの `git show <base>:<path>`」を発射して stderr noise
    // を出し、R では from/to の取り違えで rename が added 扱いに倒れる。
    //
    // lookup 失敗 (= orderedFileChanges に該当 change が無い) 経路はそのまま fetch すると per-type 分岐
    // が失われて bogus stderr が再発するため、空表示にして watcher 再発火に委ねる。`orderedFileChanges`
    // は上位 watcher の deps に含まれているため、`prDiffFiles` 取得完了 / 選択 path が含まれる
    // 変化 で再発火する。本経路は (a) PR diff fetch がまだ確定していない race window
    // (b) PR diff に含まれないファイルを Filer から選択した状況、いずれも結果として空表示が妥当。
    const change = changesStore.orderedFileChanges.find((c) => c.newFilePath === filePath);
    if (change === undefined) {
      currentContent.value = undefined;
      originalContent.value = undefined;
      isBinary.value = false;
      isOriginalBinary.value = false;
      isNotFound.value = false;
      commitGitChange.value = undefined;
      loading.value = false;
      return;
    }

    const skipFrom = change.type === "A" || change.type === "U";
    const skipTo = change.type === "D";
    const fromPromise = skipFrom
      ? Promise.resolve(undefined)
      : rpcGitReadBlob({ dir, hash: baseOid, relPath: change.oldFilePath });
    const toPromise = skipTo
      ? Promise.resolve(undefined)
      : rpcFsReadFile({ dir, path: change.newFilePath });

    const fetchResult = await tryCatch(Promise.all([fromPromise, toPromise]));

    if (version !== fetchVersion) return;

    if (!fetchResult.ok) {
      error.value = fetchResult.error.message;
      notification.error("Failed to read PR diff file", fetchResult.error);
      loading.value = false;
      return;
    }

    const [blobResult, fsResult] = fetchResult.value;
    const from = blobResult?.result;
    const fromNotFound = skipFrom || (from?.notFound ?? true);
    const toNotFound = skipTo || (fsResult?.notFound ?? true);

    if (fromNotFound && toNotFound) {
      commitGitChange.value = undefined;
    } else if (fromNotFound) {
      commitGitChange.value = change.type === "R" ? "renamed" : "added";
    } else if (toNotFound) {
      commitGitChange.value = "deleted";
    } else {
      // 内容比較は renderer 側でなく Swift 側 unchanged を使うのが SSOT だが、
      // PR diff モードは to が working tree (blob OID 無し) なので unchanged 判定は持たない。
      // `modified` / `renamed` 固定にし、実体が同一なら DiffPreview 側で空 diff として描画される。
      commitGitChange.value = change.type === "R" ? "renamed" : "modified";
    }

    if (commitGitChange.value === "deleted") {
      activeMode.value = "original";
    } else if (commitGitChange.value === "modified" || commitGitChange.value === "renamed") {
      activeMode.value = "diff";
    } else {
      activeMode.value = "current";
    }

    originalContent.value = fromNotFound ? undefined : from?.content;
    isOriginalBinary.value = from?.isBinary ?? false;
    currentContent.value = toNotFound ? undefined : fsResult?.content;
    isBinary.value = fsResult?.isBinary ?? false;
    isNotFound.value = fromNotFound && toNotFound;

    loading.value = false;
  }

  /**
   * ファイル選択・git status 変化・コミット選択変化時にリセット＋再取得。
   *
   * **deps はプリミティブで揃える**: selection オブジェクトを deps にすると、`selectRelPath` /
   * `selectAbsPath` が毎回新 object literal を作るため、同一パス再クリックでも identity 変化で
   * watch が発火し refetch が連打される。path 文字列 + kind + commit selection を deps にすることで
   * 「実際に refetch が必要な軸」だけで発火させる (= 同一パス再クリックは revealVersion 経路で
   * scroll / reveal のみ走らせ content fetch は走らせない)。
   */
  watch(
    () =>
      [
        selectedDisplayPath.value,
        selection.value?.kind,
        selectedGitChange.value,
        gitGraphStore.selectedHash,
        gitGraphStore.compareHash,
        prDiffToggle.isOn,
        prDiffToggle.lockedBaseOid,
        // PR diff モードの fetchPrDiffContent は `changesStore.orderedFileChanges` から change object
        // を lookup して per-type の path 選択を行う。orderedFileChanges が確定するまで lookup 失敗で
        // フォールバックに倒れ bogus な git show を発射してしまう race を防ぐため、
        // orderedFileChanges を deps に入れて確定タイミングで再発火させる (件数表示 / 空判定と同様
        // store の SSOT computed に揃える)。
        changesStore.orderedFileChanges,
      ] as const,
    async ([path, _kind, gitChange, selectedHash, compareHash, isPrDiff], previous) => {
      // popover close 同期用の観測点。早期 return より前に増やす (docstring 参照)。
      contentEpoch.value++;

      const [prevPath, , , prevSelectedHash, prevCompareHash, prevIsPrDiff] = previous ?? [];
      // 「表示対象そのものの切替」= ファイル / コミット選択 / PR diff トグルの変化。
      // gitChange (対象ファイルの git status) や orderedFileChanges (working tree 全体の変更一覧)
      // だけの変化はここに含めない: 編集中に自分の save が書き込んだ内容がそのまま git status に
      // 反映されただけのケースを「別ファイルへの切替」と誤認すると、save のたびに編集セッションが
      // 強制終了してしまう (discard はファイルを書かないため同じ経路を踏まず、この問題を再現しない)。
      const targetChanged =
        previous === undefined ||
        path !== prevPath ||
        selectedHash !== prevSelectedHash ||
        compareHash !== prevCompareHash ||
        isPrDiff !== prevIsPrDiff;

      // 編集中に対象切替ではない再発火 (自分の save 由来の git status 反映等) が来た場合は無視する。
      // fsChange ハンドラの `if (editStore.editMode) return` と同じ規律。
      if (!targetChanged && editStore.editMode) return;

      previewEnabled.value = defaultPreviewEnabled(fileType.value);
      commitGitChange.value = undefined;
      // ファイル切替 / コミット選択変化は表示内容の入れ替えを意味するため、編集中の draft は
      // 無条件で破棄する (別ファイルの内容を編集し続ける状態を作らない)。
      editStore.exitEditMode();

      const sel = selection.value;
      if (path === undefined || sel === undefined) {
        currentContent.value = undefined;
        originalContent.value = undefined;
        isBinary.value = false;
        isOriginalBinary.value = false;
        isDirectory.value = false;
        isNotFound.value = false;
        error.value = undefined;
        return;
      }

      // PR diff モードは graph selection より優先。worktreeRelative のみ対象 (絶対パスは git 履歴なし)。
      if (isPrDiff && sel.kind === "worktreeRelative") {
        await fetchPrDiffContent(sel.relPath);
        return;
      }
      const isCommitSelection = selectedHash !== UNCOMMITTED_HASH || compareHash !== null;
      // 絶対パス（worktree 外）は git 履歴を持たないため、commit mode 中でも fsReadFileAbsolute
      // 経路に倒す。
      if (isCommitSelection && sel.kind === "worktreeRelative") {
        await fetchCommitContent(sel.relPath);
      } else {
        activeMode.value = defaultMode(gitChange);
        await fetchContent(sel, gitChange);
      }
    },
    { immediate: true },
  );

  /** ファイル変更通知で選択中ファイルの内容を再取得（モード・UI状態は維持） */
  const unsubscribeFsChange = onMessage<FsChangePayload>(
    "fsChange",
    ({ dir: eventDir, relDir }) => {
      const sel = selection.value;
      if (sel === undefined) return;
      // useFsWatchSync は全 worktree を watch するため、active dir 以外の event は無視する。
      if (eventDir !== worktreeStore.dir) return;
      if (sel.kind !== "worktreeRelative") return;
      if (relDir !== relDirOf(sel.relPath)) return;
      // 編集中は外部変更で draft の元になった currentContent を上書きしない。保存 (editMode を
      // false にする) 後の fsChange は通常経路で再取得され、書き込んだ内容がサーバ確定値と揃う。
      if (editStore.editMode) return;

      // PR diff モードでは to が working tree のため、fs change で再取得する必要がある。
      if (prDiffToggle.isOn) {
        options.onBeforeRefetch?.(eventDir, sel.relPath);
        void fetchPrDiffContent(sel.relPath);
        return;
      }
      // commit モードではファイル変更通知を無視（表示内容は git オブジェクトから取得済み）
      if (gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null) {
        return;
      }
      options.onBeforeRefetch?.(eventDir, sel.relPath);
      void fetchContent(sel, selectedGitChange.value);
    },
  );
  onUnmounted(unsubscribeFsChange);

  /** 表示中のテキストコンテンツ */
  const displayContent = computed(() => {
    if (activeMode.value === "original") return originalContent.value;
    return currentContent.value;
  });

  const displayIsBinary = computed(() => {
    if (activeMode.value === "original") return isOriginalBinary.value;
    return isBinary.value;
  });

  /**
   * template の v-else-if 連鎖冒頭 4 分岐 (loading/directory/notFound/error) と共有する判定。
   * isCodePreviewActive / isDiffPreviewActive の両方がこの 4 条件を前提にしているため、
   * 個別に書くと drift しうる箇所を 1 つに集約する。
   */
  const isContentUnavailable = computed(
    () => loading.value || isDirectory.value || isNotFound.value || error.value !== undefined,
  );

  /** 画像として表示する URL */
  const imageUrl = computed(() => {
    if (!previewEnabled.value) return undefined;
    const ft = fileType.value;
    if (ft !== "image" && ft !== "svg") return undefined;
    const sel = selection.value;
    if (sel === undefined) return undefined;
    // 絶対パス（worktree 外）は dir 制約のない `/abs` 経路で配信する。git 履歴を持たないため
    // Original タブは無く、常に working tree の実ファイルを指す。
    if (sel.kind === "absolute") {
      return buildAbsFileServerUrl(sel.absPath, fetchVersionRef.value);
    }
    const relPath = selectedRelPath.value;
    const dir = worktreeStore.dir;
    if (relPath === undefined || dir === undefined) return undefined;
    const isOriginal = activeMode.value === "original";
    // Original タブは `git show HEAD:<path>` 配信。rename されたファイルは HEAD 側に
    // 新パスが存在しないため旧パスで引く (テキスト経路の fetchContent と同じ規律)。
    // `renameOldPaths` は現在の working tree の git status 由来 (= uncommitted 専用) のため、
    // commit / PR diff モードでは適用しない (fetchContent の mode 分離と同じ非対称を作らない)。
    const isUncommitted = !isCommitMode.value && !prDiffToggle.isOn;
    const serverPath =
      isOriginal && isUncommitted ? (gitStatusStore.renameOldPaths[relPath] ?? relPath) : relPath;
    return buildFileServerUrl(dir, serverPath, fetchVersionRef.value, isOriginal);
  });

  return {
    // 表示種別・トグル
    fileType,
    previewEnabled,
    // モード
    activeMode,
    availableModes,
    originalHashLabel,
    // 取得状態
    loading,
    error,
    isDirectory,
    isNotFound,
    isContentUnavailable,
    currentContent,
    originalContent,
    displayContent,
    displayIsBinary,
    // git 文脈
    effectiveGitChange,
    isCommitMode,
    orderedRange,
    // 画像
    imageUrl,
    // popover close 同期用の観測点
    contentEpoch,
  };
}
