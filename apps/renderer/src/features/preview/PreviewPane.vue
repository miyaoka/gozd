<doc lang="md">
ファイルプレビューの統合コンテナ。選択ファイルの拡張子に応じて子コンポーネントを切り替える。

## プレビュー種別

- コード → CodePreview（Shiki ハイライト）
- 差分 → DiffPreview（`git diff --no-index` で取得した hunk 配列を描画）
- 画像 / SVG → ImagePreview（ファイルサーバー URL）
- Markdown → MarkdownPreview（marked + DOMPurify）

## モード切替

- git 変更があるファイルでは Current / Diff / Original タブを表示
- SVG・Markdown・画像は Preview チェックボックスでレンダリング/ソース表示を切替可能

## データ取得

- Uncommitted モード: ファイル選択・git status 変化時に current（ファイルシステム）/ original（HEAD）を並列取得
- コミットモード: git-graph の選択コミットに応じて gitShowCommitFile RPC で from/to を一括取得。
  範囲選択時は `commits` 配列の index で時系列順に整列し（クリック順非依存）、older 側を Original、newer 側を Current に固定する
- fsChange メッセージで選択中ファイルをリアクティブに再取得（uncommitted モードのみ）
- バージョンカウンターで非同期レースを防止
- 表示中ファイルが削除され current が notFound になったとき、HEAD にも内容が無ければ（未追跡ファイルの削除等）
  `usePreviewStore.closeForMissingSelection` で選択解除 + close する。追跡下削除は HEAD に残るため維持

## ヘッダの back / forward ボタン

Markdown preview の内部リンク履歴 (`useMarkdownHistoryStore`) を操作する矢印ボタン。
履歴の有無で header の幅が揺れないよう常時描画し、`canGoBack` / `canGoForward` が false の側は
`disabled` 属性 + `disabled:text-foreground-muted` で見た目だけ落とす (Primer "NEVER use opacity for disabled" 規律に従い solid token を使う)。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { useChangesStore, useChangesSummaryStore } from "../changes";
import { getFileIconUrl, relDirOf, rpcFsReadFile, rpcFsReadFileAbsolute } from "../filer";
import type { FsChangePayload } from "../filer";
import { rpcGitReadBlob, useGitGraphStore, usePrDiffToggleStore } from "../git-graph";
import { UNCOMMITTED_HASH, useWorktreeStore } from "../worktree";
import type { GitChangeKind, Selection } from "../worktree";
import ChangesSummaryView from "./ChangesSummaryView.vue";
import CodePreview from "./CodePreview.vue";
import DiffPreview from "./DiffPreview.vue";
import ImagePreview from "./ImagePreview.vue";
import MarkdownPreview from "./MarkdownPreview.vue";
import { previewFontFamily, previewFontSize } from "./previewConfig";
import { rpcGitShowCommitFile, rpcGitShowFile } from "./rpc";
import { shouldCloseForMissingFile } from "./shouldCloseForMissingFile";
import { useBlamePopover } from "./useBlamePopover";
import { useMarkdownHistoryStore } from "./useMarkdownHistoryStore";
import { usePreviewStore } from "./usePreviewStore";

type PreviewMode = "current" | "diff" | "original";

/** ファイルの表示種別 */
type FileType = "image" | "svg" | "markdown" | "code" | "binary";

const FILE_TYPE_EXTENSIONS: Record<string, FileType> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  ico: "image",
  bmp: "image",
  svg: "svg",
  md: "markdown",
};

function detectFileType(filePath: string): FileType {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return FILE_TYPE_EXTENSIONS[ext] ?? "code";
}

/** rendered 表示を持つファイル種別か */
function hasRenderedView(ft: FileType): boolean {
  return ft === "svg" || ft === "markdown" || ft === "image";
}

const emit = defineEmits<{
  close: [];
}>();

const worktreeStore = useWorktreeStore();
const {
  selection,
  selectedRelPath,
  selectedDisplayPath,
  selectedLineNumber,
  selectedGitChange,
  fileServerBaseUrl,
  revealVersion,
} = storeToRefs(worktreeStore);
const gitGraphStore = useGitGraphStore();
const prDiffToggle = usePrDiffToggleStore();
const summaryStore = useChangesSummaryStore();
const changesStore = useChangesStore();
const previewStore = usePreviewStore();
const markdownHistory = useMarkdownHistoryStore();
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

/** Preview チェックボックス（SVG / Markdown / 画像で使用） */
const previewEnabled = ref(true);

/** コード折り返しトグル */
const wordWrap = ref(true);

/** コミットモード時の変更種別（from/to の取得結果から導出） */
const commitGitChange = ref<GitChangeKind>();

/** 実効的な変更種別（uncommitted モードでは git status、commit / PR diff モードでは取得結果から導出） */
const effectiveGitChange = computed(() => {
  if (prDiffToggle.isOn) return commitGitChange.value;
  if (gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null) {
    return commitGitChange.value;
  }
  return selectedGitChange.value;
});

/** diff がある変更種別か */
function hasGitDiff(gitChange: GitChangeKind | undefined): boolean {
  if (gitChange === undefined) return false;
  return gitChange !== "untracked";
}

const fileType = computed<FileType>(() => {
  const path = selectedDisplayPath.value;
  if (path === undefined) return "code";
  return detectFileType(path);
});

/** 選択中パスが worktree 外の絶対パスか（terminal link から worktree 外を開いた場合） */
const isExternalPath = computed(() => selection.value?.kind === "absolute");

/** 画像プレビュー表示中か（diff 不可のため モード制限に使用） */
const isImagePreview = computed(() => {
  const ft = fileType.value;
  return (ft === "image" || ft === "svg") && previewEnabled.value;
});

/** 選択ファイルの変更状態に応じて利用可能なモード一覧を返す */
const availableModes = computed<PreviewMode[]>(() => {
  const gitChange = effectiveGitChange.value;
  if (gitChange === "deleted") return ["original"];
  if (hasGitDiff(gitChange)) {
    // 画像プレビュー中は diff モードを除外
    if (isImagePreview.value) return ["original", "current"];
    return ["original", "diff", "current"];
  }
  return ["current"];
});

/** デフォルトモードの決定 */
function defaultMode(gitChange: GitChangeKind | undefined): PreviewMode {
  if (gitChange === "deleted") return "original";
  if (hasGitDiff(gitChange)) return "diff";
  return "current";
}

const MODE_ICONS: Record<PreviewMode, string> = {
  current: "icon-[lucide--file-text]",
  diff: "icon-[lucide--file-diff]",
  original: "icon-[lucide--file-clock]",
};

const SHORT_HASH_LEN = 7;

/**
 * 範囲選択を時系列順に整列した {newer, older}。
 * commits[0] が newest（小さい idx ほど新しい）。UNCOMMITTED_HASH は idx=-1 扱いで常に newer 側。
 * compareHash が null の単一選択時は older は undefined。
 *
 * 不整合（commits 未ロード / stale 選択 / 両端 UNCOMMITTED）のときは null を返す。
 * 呼び出し側で UI fallback（fetchCommitContent はエラー化、ラベルは "Original" の hash 表記なしに倒す）。
 * 黙って older 側に倒すと選択順依存のバグが再発するため fallback では絶対に補わない。
 */
type OrderedRange = { newer: string; older: string | undefined };
const orderedRange = computed<OrderedRange | null>(() => {
  const selected = gitGraphStore.selectedHash;
  const compare = gitGraphStore.compareHash;
  if (compare === null) return { newer: selected, older: undefined };

  // 両端 UNCOMMITTED_HASH は store API レイヤーでガードしていない不整合。null を返す。
  if (selected === UNCOMMITTED_HASH && compare === UNCOMMITTED_HASH) return null;

  const map = gitGraphStore.hashToIndex;
  const idx = (h: string) => {
    if (h === UNCOMMITTED_HASH) return -1;
    return map.get(h);
  };
  const selectedIdx = idx(selected);
  const compareIdx = idx(compare);
  if (selectedIdx === undefined || compareIdx === undefined) return null;
  // idx が大きい方が older
  if (selectedIdx >= compareIdx) return { newer: compare, older: selected };
  return { newer: selected, older: compare };
});

/**
 * Original タブが指している hash の表記。
 * Swift 側 handleGitShowCommitFile の fromHash と一致させる:
 * - PR diff モード: PR base OID (^ なし)
 * - uncommitted モード (newer=Working Tree, older=undefined): HEAD
 * - 単一コミット: <hash>^
 * - 範囲選択: <older>^
 * - orderedRange が null（不整合）: undefined を返す。`modeLabel` 側で hash 表記なしに倒し、
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

function modeLabel(mode: PreviewMode): string {
  if (mode === "current") return "Current";
  if (mode === "diff") return "Diff";
  const label = originalHashLabel.value;
  return label === undefined ? "Original" : `Original (${label})`;
}

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
  const originalPromise =
    sel.kind === "worktreeRelative" && (hasDiff || isDeleted)
      ? rpcGitShowFile({ dir, relPath: sel.relPath }).then((r) => r.result)
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
 * 個別ファイル選択時のみ summary モードを抜ける。
 * git-graph の commit 切替 (selectedHash / compareHash の変化) では summary は維持する。
 * `revealVersion` は select*Path() 専用のバージョンカウンタなので、これを trigger に使うことで
 * 「ユーザーがファイル行を実際にクリックした」経路のみで disable が走る。
 */
watch(
  () => [selectedDisplayPath.value, revealVersion.value] as const,
  ([path]) => {
    if (path !== undefined) {
      summaryStore.disable();
    }
  },
);

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
  async ([path, _kind, gitChange, selectedHash, compareHash, isPrDiff]) => {
    previewEnabled.value = true;
    commitGitChange.value = undefined;

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
    const isCommitMode = selectedHash !== UNCOMMITTED_HASH || compareHash !== null;
    // 絶対パス（worktree 外）は git 履歴を持たないため、commit mode 中でも fsReadFileAbsolute
    // 経路に倒す。
    if (isCommitMode && sel.kind === "worktreeRelative") {
      await fetchCommitContent(sel.relPath);
    } else {
      activeMode.value = defaultMode(gitChange);
      await fetchContent(sel, gitChange);
    }
  },
  { immediate: true },
);

/** ファイル変更通知で選択中ファイルの内容を再取得（モード・UI状態は維持） */
const unsubscribeFsChange = onMessage<FsChangePayload>("fsChange", ({ dir: eventDir, relDir }) => {
  const sel = selection.value;
  if (sel === undefined) return;
  // useFsWatchSync は全 worktree を watch するため、active dir 以外の event は無視する。
  if (eventDir !== worktreeStore.dir) return;
  if (sel.kind !== "worktreeRelative") return;
  if (relDir !== relDirOf(sel.relPath)) return;

  // PR diff モードでは to が working tree のため、fs change で再取得する必要がある。
  if (prDiffToggle.isOn) {
    blamePopover.closeIfActive(eventDir, sel.relPath);
    void fetchPrDiffContent(sel.relPath);
    return;
  }
  // commit モードではファイル変更通知を無視（表示内容は git オブジェクトから取得済み）
  if (gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null) {
    return;
  }
  // fetchContent で currentContent / originalContent が更新されると CodePreview / DiffPreview
  // が再ハイライト・再描画し、line-no button DOM が置換される。blame popover が同 file に
  // 対して開いていれば anchorEl が detached になるため、再 fetch 前に閉じる。
  blamePopover.closeIfActive(eventDir, sel.relPath);
  void fetchContent(sel, selectedGitChange.value);
});
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
 * `gozd-file://` URLSchemeHandler の URL を構築。worktree 相対パスのみが対象
 * (file server は worktree 配下を提供する経路)。絶対パス選択中は呼び出さない。
 *
 * 形式: `gozd-file://localhost/{fs|git}?dir=<absDir>&path=<relPath>&v=<version>`
 *   - `/fs`  : 作業ツリーの実ファイル
 *   - `/git` : `git show HEAD:<path>` の出力 (Original タブの画像)
 *
 * `?v=` は fsChange 等で同一 URL を再読み込みさせるためのキャッシュバスト。
 */
function buildFileServerUrl(
  dir: string,
  relPath: string,
  version: number,
  gitOriginal = false,
): string | undefined {
  const base = fileServerBaseUrl.value;
  if (!base) return undefined;
  const kind = gitOriginal ? "git" : "fs";
  const url = new URL(kind, base);
  url.searchParams.set("dir", dir);
  url.searchParams.set("path", relPath);
  url.searchParams.set("v", String(version));
  return url.href;
}

/** 画像として表示する URL */
const imageUrl = computed(() => {
  if (!previewEnabled.value) return undefined;
  const ft = fileType.value;
  if (ft !== "image" && ft !== "svg") return undefined;
  // 絶対パス（worktree 外）は file server 経路で扱えない。画像/SVG は
  // fsReadFileAbsolute 経由の binary 表示にフォールバックする。
  const relPath = selectedRelPath.value;
  const dir = worktreeStore.dir;
  if (relPath === undefined || dir === undefined) return undefined;
  const isOriginal = activeMode.value === "original";
  return buildFileServerUrl(dir, relPath, fetchVersionRef.value, isOriginal);
});

/** preview チェックボックスを表示するか（diff モードでは非表示） */
const showPreviewCheckbox = computed(() => {
  if (activeMode.value === "diff") return false;
  // 絶対パス（worktree 外）の image / svg は file server 経由で読めないため Preview トグルを出さない。
  // markdown はテキスト経路で読めるためトグル対象を維持する。
  if (isExternalPath.value && (fileType.value === "image" || fileType.value === "svg")) {
    return false;
  }
  return hasRenderedView(fileType.value);
});

function fileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

const headerIconUrl = computed(() => {
  const path = selectedDisplayPath.value;
  if (path === undefined) return undefined;
  return getFileIconUrl(fileName(path));
});

/**
 * commit mode (single 単体 or 範囲) かを集約判定。
 * `orderedRange` の null 経路を分けるのに使う。
 */
const isCommitMode = computed(
  () => gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null,
);

/**
 * Current 側 (newer / working tree) を blame する際の rev。
 * - PR diff モード: "" = working tree
 * - uncommitted モード: "" = working tree
 * - commit モード: newer hash (Working Tree なら "")
 * orderedRange が null (不整合) なら undefined を返し、blame button は描画自体抑止する。
 */
const currentRev = computed<string | undefined>(() => {
  if (prDiffToggle.isOn) return "";
  if (!isCommitMode.value) return "";
  const range = orderedRange.value;
  if (range === null) return undefined;
  return range.newer === UNCOMMITTED_HASH ? "" : range.newer;
});

/**
 * Original 側 (older^) を blame する際の rev。
 * - PR diff モード: `lockedBaseOid` (= `merge-base(HEAD, baseRefOid)`) を起点に blame する。
 *   ただし PR で追加されたファイル (effectiveKind === "added") は merge-base に存在しないため
 *   undefined を返し、blame button 経路で silent dead button にならないよう `blameEnabled` 側で
 *   構造的に抑止する。
 * - uncommitted モード: "HEAD"
 * - commit モード: `<older>^`。range.older は orderedRange が null でない限り
 *   必ず string で来る (型保証)。fetchCommitContent の fromHash と一致。
 */
const originalRev = computed<string | undefined>(() => {
  if (prDiffToggle.isOn) {
    if (effectiveGitChange.value === "added") return undefined;
    return prDiffToggle.lockedBaseOid;
  }
  if (!isCommitMode.value) return "HEAD";
  const range = orderedRange.value;
  if (range === null) return undefined;
  if (range.older === undefined) {
    // 単一 commit 選択 (compareHash === null)。fetchCommitContent と同じく `<newer>^`
    return `${range.newer}^`;
  }
  return `${range.older}^`;
});

/** blame 不可なファイル (絶対パスの外部 open / PR diff の added file) を弾く判定。
 *  button 描画自体を gate して silent dead button (DiffPreview docstring 規約) を作らない。
 *
 *  - worktreeRelative 以外 (absolute path) は git 履歴なしで blame 不成立
 *  - PR diff で added file は old 側 blame が `git blame <baseOid> -- <path>` で path 不在エラーに
 *    なるため、両側まとめて抑止する (現状の DiffPreview 単一 prop の API 制約上、side ごとに
 *    gate できないため最小コスト解。新側 blame も失うが、added file の PR view では trade-off で許容)
 */
const blameEnabled = computed(() => {
  if (selection.value?.kind !== "worktreeRelative") return false;
  if (prDiffToggle.isOn && effectiveGitChange.value === "added") return false;
  return true;
});

const blamePopover = useBlamePopover();

function modeLabelForRev(rev: string): string {
  if (rev === "") return "Working Tree";
  if (rev === "HEAD") return "HEAD";
  return rev;
}

function openBlame(rev: string, line: number, anchorEl: HTMLElement): void {
  const dir = worktreeStore.dir;
  const relPath = selectedRelPath.value;
  // 絶対パス選択中 (worktree 外) は relPath が undefined になり blame を成立できない。
  // `blameEnabled` で button 描画自体を gate しているため通常は到達しないが、二重防御として early return。
  if (dir === undefined || relPath === undefined) return;
  blamePopover.open(anchorEl, {
    dir,
    relPath,
    rev,
    line,
    modeLabel: modeLabelForRev(rev),
  });
}

function onCodeLineClick(payload: { line: number; anchorEl: HTMLElement }): void {
  // CodePreview は activeMode の content (current か original) をそのまま渡しているので
  // activeMode に応じて rev を切り替える。
  const rev = activeMode.value === "original" ? originalRev.value : currentRev.value;
  if (rev === undefined) return;
  openBlame(rev, payload.line, payload.anchorEl);
}

function onDiffLineClick(payload: {
  side: "old" | "new";
  line: number;
  anchorEl: HTMLElement;
}): void {
  const rev = payload.side === "old" ? originalRev.value : currentRev.value;
  if (rev === undefined) return;
  openBlame(rev, payload.line, payload.anchorEl);
}

/**
 * 表示中ファイル / commit selection / mode 切替で popover を必ず閉じる。
 * 文脈と blame popover が乖離した状態 (file B を選択しているのに popover は file A
 * の Line N を指す) を残さないための watcher。
 */
watch(
  [
    // content reload watcher (上で定義) の deps と同一集合にする。
    // 「content が更新される条件」と「popover を閉じる条件」が分かれていると、
    // selectedGitChange だけ変化 (status push で modified ↔ renamed 等) し
    // activeMode が同値に解決される経路で reload が走るが close は fire せず、
    // CodePreview / DiffPreview の再描画で button DOM が置換され anchor が detached
    // になる。両 watcher の deps を同期させて invariant「content が変わるなら必ず close」
    // を構造で保証する。
    // selection 自体は object identity が毎クリック変わるため、プリミティブで揃える。
    selectedDisplayPath,
    () => selection.value?.kind,
    selectedGitChange,
    () => gitGraphStore.selectedHash,
    () => gitGraphStore.compareHash,
    () => prDiffToggle.isOn,
    () => prDiffToggle.lockedBaseOid,
    () => changesStore.orderedFileChanges,
    activeMode,
    // summary view 切替で CodePreview / DiffPreview が unmount され anchor が detached
    // になるため、popover も同時に閉じる必要がある。
    () => summaryStore.enabled,
  ],
  () => {
    if (blamePopover.context.value !== undefined) {
      blamePopover.close();
    }
  },
);
</script>

<template>
  <ChangesSummaryView v-if="summaryStore.enabled" @close="previewStore.close()" />

  <div v-else class="flex h-full flex-col overflow-hidden">
    <!-- ヘッダー（常に表示） -->
    <div class="flex items-center gap-2 border-b border-border px-3 py-2">
      <!-- markdown preview 内部リンク履歴ナビ。履歴の有無でレイアウトが揺れないよう常時表示 -->
      <button
        type="button"
        class="shrink-0 text-foreground-low hover:text-foreground disabled:cursor-default disabled:text-foreground-muted disabled:hover:text-foreground-muted"
        :disabled="!markdownHistory.canGoBack"
        title="Go back"
        aria-label="Go back"
        @click="markdownHistory.goBack()"
      >
        <span class="icon-[lucide--arrow-left] size-4" />
      </button>
      <button
        type="button"
        class="shrink-0 text-foreground-low hover:text-foreground disabled:cursor-default disabled:text-foreground-muted disabled:hover:text-foreground-muted"
        :disabled="!markdownHistory.canGoForward"
        title="Go forward"
        aria-label="Go forward"
        @click="markdownHistory.goForward()"
      >
        <span class="icon-[lucide--arrow-right] size-4" />
      </button>
      <template v-if="selectedDisplayPath">
        <img :src="headerIconUrl" class="size-4 shrink-0" alt="" />
        <span class="truncate text-sm text-foreground" :title="selectedDisplayPath">{{
          fileName(selectedDisplayPath)
        }}</span>
      </template>
      <span v-else class="text-sm text-foreground-low">Preview</span>
      <button
        type="button"
        class="ml-auto shrink-0 text-foreground-low hover:text-foreground"
        title="Close preview"
        aria-label="Close preview"
        @click="emit('close')"
      >
        <span class="icon-[lucide--x] size-4" />
      </button>
    </div>

    <!-- 未選択 -->
    <div
      v-if="!selectedDisplayPath"
      class="flex flex-1 items-center justify-center text-sm text-foreground-low"
    >
      Select a file to preview
    </div>

    <!-- 選択中 -->
    <template v-else>
      <!-- ツールバー (モード切替タブ / Preview / Wrap) -->
      <div class="flex items-center border-b border-border">
        <!-- モード切替タブ -->
        <button
          v-for="mode in availableModes"
          :key="mode"
          class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
          :class="
            activeMode === mode
              ? 'border-b-2 border-primary text-primary-text'
              : 'text-foreground-low hover:text-foreground'
          "
          @click="activeMode = mode"
        >
          <span class="size-3.5" :class="MODE_ICONS[mode]" />
          {{ modeLabel(mode) }}
        </button>

        <div class="ml-auto flex items-center">
          <!-- Preview トグル -->
          <button
            v-if="showPreviewCheckbox"
            class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
            :class="
              previewEnabled ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
            "
            @click="previewEnabled = !previewEnabled"
          >
            <span class="icon-[lucide--eye] size-3.5" />
            Preview
          </button>

          <!-- Wrap トグル -->
          <button
            class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
            :class="wordWrap ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'"
            @click="wordWrap = !wordWrap"
          >
            <span class="icon-[lucide--wrap-text] size-3.5" />
            Wrap
          </button>
        </div>
      </div>

      <!--
        コンテンツ。Cmd+A scope は各 leaf (CodePreview / MarkdownPreview / DiffPreview) 側の
        contenteditable で完結させる。PreviewPane 側はラッパとしてのみ振る舞い、contenteditable
        を持たないことで nested editing host の不安定領域を踏まない。
      -->
      <div
        class="flex-1 overflow-auto"
        :style="{
          fontFamily: previewFontFamily || undefined,
          fontSize: previewFontSize > 0 ? `${previewFontSize}px` : undefined,
        }"
      >
        <div v-if="loading" class="p-4 text-sm text-foreground-low">Loading...</div>

        <div v-else-if="isDirectory" class="p-4 text-sm text-foreground-low">Directory</div>

        <div v-else-if="isNotFound" class="p-4 text-sm text-foreground-low">File not found</div>

        <div v-else-if="error" class="p-4 text-sm text-destructive-text">{{ error }}</div>

        <!-- diff モード -->
        <DiffPreview
          v-else-if="
            activeMode === 'diff' && originalContent !== undefined && currentContent !== undefined
          "
          :original="originalContent"
          :current="currentContent"
          :file-path="selectedDisplayPath ?? ''"
          :word-wrap="wordWrap"
          :blame-enabled="blameEnabled"
          @line-number-click="onDiffLineClick"
        />

        <!-- 画像プレビュー（バイナリ画像 + SVG preview モード） -->
        <ImagePreview v-else-if="imageUrl" :src="imageUrl" />

        <!-- worktree 外の絶対パス image / svg は file server 経由で読めないため未対応を明示する -->
        <div
          v-else-if="(fileType === 'image' || fileType === 'svg') && isExternalPath"
          class="p-4 text-sm text-foreground-low"
        >
          Image preview is not available for paths outside the worktree
        </div>

        <!-- バイナリ（画像以外） -->
        <div v-else-if="displayIsBinary" class="p-4 text-sm text-foreground-low">
          Binary file — preview not available
        </div>

        <!-- Markdown preview モード -->
        <MarkdownPreview
          v-else-if="fileType === 'markdown' && previewEnabled && displayContent"
          :content="displayContent"
        />

        <!-- コード表示 -->
        <CodePreview
          v-else-if="displayContent !== undefined"
          :content="displayContent"
          :file-path="selectedDisplayPath"
          :line-number="selectedLineNumber"
          :reveal-version="revealVersion"
          :word-wrap="wordWrap"
          :blame-enabled="blameEnabled"
          @line-number-click="onCodeLineClick"
        />
      </div>
    </template>
  </div>
</template>
