<doc lang="md">
ファイルプレビューの統合コンテナ。選択ファイルの拡張子に応じて子コンポーネントを切り替える。

## プレビュー種別

- コード → CodePreview（Shiki ハイライト）
- 差分 → DiffPreview（jsdiff 行単位）
- 画像 / SVG → ImagePreview（ファイルサーバー URL）
- Markdown → MarkdownPreview（marked + DOMPurify）

## モード切替

- git 変更があるファイルでは Current / Diff / Original タブを表示
- SVG・Markdown・画像は Preview チェックボックスでレンダリング/ソース表示を切替可能

## データ取得

- Uncommitted モード: ファイル選択・git status 変化時に current（ファイルシステム）/ original（HEAD）を並列取得
- コミットモード: git-graph の選択コミットに応じて gitShowCommitFile RPC で from/to を一括取得
- fsChange メッセージで選択中ファイルをリアクティブに再取得（uncommitted モードのみ）
- バージョンカウンターで非同期レースを防止
</doc>

<script setup lang="ts">
import { UNCOMMITTED_HASH } from "@gozd/rpc";
import { storeToRefs } from "pinia";
import { computed, onUnmounted, ref, watch } from "vue";
import { useRpc } from "../../shared/rpc";
import { getFileIconName, getIconUrl } from "../filer";
import { useGitGraphStore } from "../git-graph";
import { useWorktreeStore } from "../worktree";
import type { GitChangeKind } from "../worktree";
import CodePreview from "./CodePreview.vue";
import DiffPreview from "./DiffPreview.vue";
import ImagePreview from "./ImagePreview.vue";
import MarkdownPreview from "./MarkdownPreview.vue";
import { previewFontFamily, previewFontSize } from "./previewConfig";

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
const { request, onFsChange } = useRpc();

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

const MODE_LABELS: Record<PreviewMode, { icon: string; label: string }> = {
  current: { icon: "icon-[lucide--file-text]", label: "Current" },
  diff: { icon: "icon-[lucide--file-diff]", label: "Diff" },
  original: { icon: "icon-[lucide--file-clock]", label: "Original" },
};

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

  try {
    const isDeleted = gitChange === "deleted";
    const hasDiff = hasGitDiff(gitChange);

    // 絶対パスの場合は fsReadFileAbsolute を使い、git 操作は不要
    const isAbsolute = path.startsWith("/");

    // 並列でデータ取得
    const [currentResult, originalResult] = await Promise.all([
      isDeleted
        ? undefined
        : isAbsolute
          ? request.fsReadFileAbsolute({ absolutePath: path })
          : request.fsReadFile({ relPath: path }),
      !isAbsolute && (hasDiff || isDeleted) ? request.gitShowFile({ relPath: path }) : undefined,
    ]);

    // 別の読み込みが開始された場合は結果を破棄
    if (version !== fetchVersion) return;

    isDirectory.value = currentResult?.isDirectory ?? false;
    isNotFound.value = currentResult?.notFound ?? false;

    if (currentResult) {
      currentContent.value = currentResult.content;
      isBinary.value = currentResult.isBinary;
    } else {
      currentContent.value = undefined;
      isBinary.value = false;
    }
    if (originalResult) {
      originalContent.value = originalResult.content;
      isOriginalBinary.value = originalResult.isBinary;
    } else {
      originalContent.value = undefined;
      isOriginalBinary.value = false;
    }
  } catch (e) {
    if (version !== fetchVersion) return;
    error.value = e instanceof Error ? e.message : "Failed to read file";
  } finally {
    if (version === fetchVersion) {
      loading.value = false;
    }
  }
}

/** コミットモード時のファイル内容取得 */
async function fetchCommitContent(filePath: string) {
  loading.value = true;
  error.value = undefined;
  isDirectory.value = false;
  isNotFound.value = false;

  const version = ++fetchVersion;
  fetchVersionRef.value = version;

  try {
    const result = await request.gitShowCommitFile({
      relPath: filePath,
      hash: gitGraphStore.selectedHash,
      compareHash: gitGraphStore.compareHash ?? undefined,
    });

    if (version !== fetchVersion) return;

    const { from, to } = result;

    // from/to の状態から変更種別を導出
    if (from.notFound && !to.notFound) {
      commitGitChange.value = "added";
    } else if (!from.notFound && to.notFound) {
      commitGitChange.value = "deleted";
    } else {
      commitGitChange.value = "modified";
    }

    // デフォルトモードを変更種別に応じて設定
    if (commitGitChange.value === "deleted") {
      activeMode.value = "original";
    } else if (commitGitChange.value === "added") {
      activeMode.value = "current";
    } else {
      activeMode.value = "diff";
    }

    originalContent.value = from.notFound ? undefined : from.content;
    isOriginalBinary.value = from.isBinary;
    currentContent.value = to.notFound ? undefined : to.content;
    isBinary.value = to.isBinary;
    isNotFound.value = (from.notFound ?? false) && (to.notFound ?? false);
  } catch (e) {
    if (version !== fetchVersion) return;
    error.value = e instanceof Error ? e.message : "Failed to read file";
  } finally {
    if (version === fetchVersion) {
      loading.value = false;
    }
  }
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
function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  if (idx < 0) return ".";
  return filePath.substring(0, idx);
}

const unsubscribeFsChange = onFsChange(({ relDir }) => {
  if (!selectedPath.value) return;
  // コミットモードではファイル変更通知を無視（表示内容は git オブジェクトから取得済み）
  if (gitGraphStore.selectedHash !== UNCOMMITTED_HASH || gitGraphStore.compareHash !== null) return;
  if (relDir !== parentDir(selectedPath.value)) return;
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
  if (!selectedPath.value) return undefined;
  return getIconUrl(getFileIconName(fileName(selectedPath.value)));
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- ヘッダー（常に表示） -->
    <div class="flex items-center gap-2 border-b border-zinc-700 px-3 py-2">
      <template v-if="selectedPath">
        <img v-if="headerIconUrl" :src="headerIconUrl" class="size-4 shrink-0" alt="" />
        <span v-else class="icon-[lucide--file-text] text-zinc-400" />
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
          <span class="size-3.5" :class="MODE_LABELS[mode].icon" />
          {{ MODE_LABELS[mode].label }}
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
