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
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { getFileIconUrl, relDirOf, rpcFsReadFile, rpcFsReadFileAbsolute } from "../filer";
import type { FsChangePayload } from "../filer";
import { useGitGraphStore } from "../git-graph";
import { UNCOMMITTED_HASH, useWorktreeStore } from "../worktree";
import type { GitChangeKind } from "../worktree";
import CodePreview from "./CodePreview.vue";
import DiffPreview from "./DiffPreview.vue";
import ImagePreview from "./ImagePreview.vue";
import MarkdownPreview from "./MarkdownPreview.vue";
import { previewFontFamily, previewFontSize } from "./previewConfig";
import { rpcGitShowCommitFile, rpcGitShowFile } from "./rpc";

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
const { selectedPath, selectedLineNumber, selectedGitChange, fileServerBaseUrl, revealVersion } =
  storeToRefs(worktreeStore);
const gitGraphStore = useGitGraphStore();
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

/** 実効的な変更種別（uncommitted モードでは git status、commit モードでは取得結果から導出） */
const effectiveGitChange = computed(() => {
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
  if (!selectedPath.value) return "code";
  return detectFileType(selectedPath.value);
});

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
 * Swift 側 handleGitShowCommitFile の fromHash (= `<olderEnd>^`) と一致させる:
 * - uncommitted モード (newer=Working Tree, older=undefined): HEAD
 * - 単一コミット: <hash>^
 * - 範囲選択: <older>^
 * - orderedRange が null（不整合）: undefined を返す。`modeLabel` 側で hash 表記なしに倒し、
 *   実際には参照していない HEAD などの虚偽情報をラベルに出さない。
 */
const originalHashLabel = computed<string | undefined>(() => {
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
async function fetchContent(path: string, gitChange: GitChangeKind | undefined) {
  loading.value = true;
  error.value = undefined;
  isDirectory.value = false;
  isNotFound.value = false;

  const version = ++fetchVersion;
  fetchVersionRef.value = version;

  const isDeleted = gitChange === "deleted";
  const hasDiff = hasGitDiff(gitChange);

  // 絶対パスの場合は fsReadFileAbsolute を使い、git 操作は不要
  const isAbsolute = path.startsWith("/");

  const dir = worktreeStore.dir;
  // await 前の同期パス: version === fetchVersion 保証のため version ガード不要。
  if (dir === undefined) {
    loading.value = false;
    return;
  }

  // 並列でデータ取得
  const currentPromise = isDeleted
    ? Promise.resolve(undefined)
    : isAbsolute
      ? rpcFsReadFileAbsolute({ absolutePath: path }).then((r) => r.result)
      : rpcFsReadFile({ dir, path }).then((r) => ({
          content: r.content,
          isBinary: r.isBinary,
          isDirectory: r.isDirectory,
          notFound: r.notFound,
        }));
  const originalPromise =
    !isAbsolute && (hasDiff || isDeleted)
      ? rpcGitShowFile({ dir, relPath: path }).then((r) => r.result)
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
          rpcGitShowCommitFile({ dir, relPath: filePath, hash: older, compareHash: "" }),
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

/** ファイル選択・git status 変化・コミット選択変化時にリセット＋再取得 */
watch(
  () =>
    [
      selectedPath.value,
      selectedGitChange.value,
      gitGraphStore.selectedHash,
      gitGraphStore.compareHash,
    ] as const,
  async ([path, gitChange, selectedHash, compareHash]) => {
    previewEnabled.value = true;
    commitGitChange.value = undefined;

    if (!path) {
      currentContent.value = undefined;
      originalContent.value = undefined;
      isBinary.value = false;
      isOriginalBinary.value = false;
      isDirectory.value = false;
      isNotFound.value = false;
      error.value = undefined;
      return;
    }

    const isCommitMode = selectedHash !== UNCOMMITTED_HASH || compareHash !== null;
    if (isCommitMode) {
      await fetchCommitContent(path);
    } else {
      activeMode.value = defaultMode(gitChange);
      await fetchContent(path, gitChange);
    }
  },
  { immediate: true },
);

/** ファイル変更通知で選択中ファイルの内容を再取得（モード・UI状態は維持） */
const unsubscribeFsChange = onMessage<FsChangePayload>("fsChange", ({ dir: eventDir, relDir }) => {
  if (!selectedPath.value) return;
  // コミットモードではファイル変更通知を無視（表示内容は git オブジェクトから取得済み）
  if (gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null) {
    return;
  }
  // useFsWatchSync は全 worktree を watch するため、active dir 以外の event は無視する。
  if (eventDir !== worktreeStore.dir) return;
  if (relDir !== relDirOf(selectedPath.value)) return;
  void fetchContent(selectedPath.value, selectedGitChange.value);
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

/** ファイルサーバー経由の URL を構築 */
function buildFileServerUrl(
  relPath: string,
  version: number,
  gitOriginal = false,
): string | undefined {
  if (!fileServerBaseUrl.value) return undefined;
  const base = fileServerBaseUrl.value.endsWith("/")
    ? fileServerBaseUrl.value
    : `${fileServerBaseUrl.value}/`;
  const prefix = gitOriginal ? "git/" : "fs/";
  const encodedPath = relPath.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`${prefix}${encodedPath}`, base);
  url.searchParams.set("v", String(version));
  return url.href;
}

/** 画像として表示する URL */
const imageUrl = computed(() => {
  if (!previewEnabled.value) return undefined;
  const ft = fileType.value;
  if ((ft === "image" || ft === "svg") && selectedPath.value) {
    const isOriginal = activeMode.value === "original";
    return buildFileServerUrl(selectedPath.value, fetchVersionRef.value, isOriginal);
  }
  return undefined;
});

/** preview チェックボックスを表示するか（diff モードでは非表示） */
const showPreviewCheckbox = computed(() => {
  if (activeMode.value === "diff") return false;
  return hasRenderedView(fileType.value);
});

function fileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}

const headerIconUrl = computed(() => {
  const path = selectedPath.value;
  if (path === undefined) return undefined;
  return getFileIconUrl(fileName(path));
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- ヘッダー（常に表示） -->
    <div class="flex items-center gap-2 border-b border-zinc-700 px-3 py-2">
      <template v-if="selectedPath">
        <img :src="headerIconUrl" class="size-4 shrink-0" alt="" />
        <span class="truncate text-sm text-zinc-300" :title="selectedPath">{{
          fileName(selectedPath)
        }}</span>
      </template>
      <span v-else class="text-sm text-zinc-500">Preview</span>
      <button
        type="button"
        class="ml-auto shrink-0 text-zinc-500 hover:text-zinc-300"
        title="Close preview"
        aria-label="Close preview"
        @click="emit('close')"
      >
        <span class="icon-[lucide--panel-right-close] size-4" />
      </button>
    </div>

    <!-- 未選択 -->
    <div v-if="!selectedPath" class="flex flex-1 items-center justify-center text-sm text-zinc-500">
      Select a file to preview
    </div>

    <!-- 選択中 -->
    <template v-else>
      <!-- ツールバー -->
      <div class="flex items-center border-b border-zinc-700">
        <!-- モード切替タブ -->
        <button
          v-for="mode in availableModes"
          :key="mode"
          class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
          :class="
            activeMode === mode
              ? 'border-b-2 border-blue-400 text-blue-400'
              : 'text-zinc-500 hover:text-zinc-300'
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
            :class="previewEnabled ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'"
            @click="previewEnabled = !previewEnabled"
          >
            <span class="icon-[lucide--eye] size-3.5" />
            Preview
          </button>

          <!-- Wrap トグル -->
          <button
            class="flex items-center gap-1 px-3 py-1.5 text-xs transition-colors"
            :class="wordWrap ? 'text-blue-400' : 'text-zinc-500 hover:text-zinc-300'"
            @click="wordWrap = !wordWrap"
          >
            <span class="icon-[lucide--wrap-text] size-3.5" />
            Wrap
          </button>
        </div>
      </div>

      <!-- コンテンツ -->
      <div
        class="flex-1 overflow-auto"
        :style="{
          fontFamily: previewFontFamily || undefined,
          fontSize: previewFontSize > 0 ? `${previewFontSize}px` : undefined,
        }"
      >
        <div v-if="loading" class="p-4 text-sm text-zinc-500">Loading...</div>

        <div v-else-if="isDirectory" class="p-4 text-sm text-zinc-500">Directory</div>

        <div v-else-if="isNotFound" class="p-4 text-sm text-zinc-500">File not found</div>

        <div v-else-if="error" class="p-4 text-sm text-red-400">{{ error }}</div>

        <!-- diff モード -->
        <DiffPreview
          v-else-if="
            activeMode === 'diff' && originalContent !== undefined && currentContent !== undefined
          "
          :original="originalContent"
          :current="currentContent"
          :file-path="selectedPath ?? ''"
          :word-wrap="wordWrap"
        />

        <!-- 画像プレビュー（バイナリ画像 + SVG preview モード） -->
        <ImagePreview v-else-if="imageUrl" :src="imageUrl" />

        <!-- バイナリ（画像以外） -->
        <div v-else-if="displayIsBinary" class="p-4 text-sm text-zinc-500">
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
          :file-path="selectedPath"
          :line-number="selectedLineNumber"
          :reveal-version="revealVersion"
          :word-wrap="wordWrap"
        />
      </div>
    </template>
  </div>
</template>
