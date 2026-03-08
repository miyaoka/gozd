<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { GitChangeKind } from "../filer/filer-utils";
import { getFileIconName, getIconUrl } from "../filer/useFileIcon";
import { useSelectedPath } from "../filer/useSelectedPath";
import { useRpc } from "../rpc/useRpc";
import CodePreview from "./CodePreview.vue";
import DiffPreview from "./DiffPreview.vue";
import ImagePreview from "./ImagePreview.vue";
import MarkdownPreview from "./MarkdownPreview.vue";

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

const { selectedPath, selectedGitChange } = useSelectedPath();
const { request } = useRpc();

const currentContent = ref<string>();
const originalContent = ref<string>();
/** バイナリ画像の data: URL */
const imageDataUrl = ref<string>();
const isBinary = ref(false);
const isOriginalBinary = ref(false);
const loading = ref(false);
const error = ref<string>();
const activeMode = ref<PreviewMode>("current");

/** Preview チェックボックス（SVG / Markdown / 画像で使用） */
const previewEnabled = ref(true);

/** diff がある変更種別か */
function hasGitDiff(gitChange: GitChangeKind | undefined): boolean {
  if (gitChange === undefined) return false;
  return gitChange !== "untracked";
}

const fileType = computed<FileType>(() => {
  if (!selectedPath.value) return "code";
  return detectFileType(selectedPath.value);
});

/** 選択ファイルの変更状態に応じて利用可能なモード一覧を返す */
const availableModes = computed<PreviewMode[]>(() => {
  const gitChange = selectedGitChange.value;
  if (gitChange === "deleted") return ["original"];
  if (hasGitDiff(gitChange)) return ["original", "diff", "current"];
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

/** 非同期レース防止用のバージョンカウンター */
let fetchVersion = 0;

watch(
  () => [selectedPath.value, selectedGitChange.value] as const,
  async ([path, gitChange]) => {
    // リセット
    currentContent.value = undefined;
    originalContent.value = undefined;
    imageDataUrl.value = undefined;
    previewEnabled.value = true;
    isBinary.value = false;
    isOriginalBinary.value = false;
    error.value = undefined;

    if (!path) return;

    activeMode.value = defaultMode(gitChange);
    loading.value = true;

    const version = ++fetchVersion;

    try {
      const isDeleted = gitChange === "deleted";
      const hasDiff = hasGitDiff(gitChange);

      // 並列でデータ取得
      const [currentResult, originalResult] = await Promise.all([
        isDeleted ? undefined : request.fsReadFile({ relPath: path }),
        hasDiff || isDeleted ? request.gitShowFile({ relPath: path }) : undefined,
      ]);

      // 別のファイルが選択された場合は結果を破棄
      if (version !== fetchVersion) return;

      if (currentResult) {
        currentContent.value = currentResult.content;
        isBinary.value = currentResult.isBinary;
        if (currentResult.dataUrl) {
          imageDataUrl.value = currentResult.dataUrl;
        }
      }
      if (originalResult) {
        originalContent.value = originalResult.content;
        isOriginalBinary.value = originalResult.isBinary;
      }
    } catch (e) {
      if (version !== fetchVersion) return;
      error.value = e instanceof Error ? e.message : "Failed to read file";
    } finally {
      if (version === fetchVersion) {
        loading.value = false;
      }
    }
  },
  { immediate: true },
);

/** 表示中のテキストコンテンツ */
const displayContent = computed(() => {
  if (activeMode.value === "original") return originalContent.value;
  return currentContent.value;
});

const displayIsBinary = computed(() => {
  if (activeMode.value === "original") return isOriginalBinary.value;
  return isBinary.value;
});

/** 画像として表示する URL */
const imageUrl = computed(() => {
  if (!previewEnabled.value) return undefined;
  if (imageDataUrl.value) return imageDataUrl.value;
  if (fileType.value === "svg" && displayContent.value) {
    const encoded = new TextEncoder().encode(displayContent.value);
    const binary = Array.from(encoded, (b) => String.fromCharCode(b)).join("");
    return `data:image/svg+xml;base64,${btoa(binary)}`;
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
    <!-- 未選択 -->
    <div v-if="!selectedPath" class="flex flex-1 items-center justify-center text-sm text-zinc-500">
      Select a file to preview
    </div>

    <!-- 選択中 -->
    <template v-else>
      <!-- ヘッダー -->
      <div class="flex items-center gap-2 border-b border-zinc-700 px-3 py-2">
        <img v-if="headerIconUrl" :src="headerIconUrl" class="size-4 shrink-0" alt="" />
        <span v-else class="icon-[lucide--file-text] text-zinc-400" />
        <span class="truncate text-sm text-zinc-300" :title="selectedPath">{{
          fileName(selectedPath)
        }}</span>
        <span class="ml-auto text-xs text-zinc-500">{{ selectedPath }}</span>
      </div>

      <!-- モード切替タブ -->
      <div
        v-if="availableModes.length > 1 || showPreviewCheckbox"
        class="flex items-center border-b border-zinc-700"
      >
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

        <!-- Preview チェックボックス -->
        <label
          v-if="showPreviewCheckbox"
          class="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 select-none"
        >
          <input v-model="previewEnabled" type="checkbox" class="accent-blue-400" />
          Preview
        </label>
      </div>

      <!-- コンテンツ -->
      <div class="flex-1 overflow-auto">
        <div v-if="loading" class="p-4 text-sm text-zinc-500">Loading...</div>

        <div v-else-if="error" class="p-4 text-sm text-red-400">{{ error }}</div>

        <!-- diff モード -->
        <DiffPreview
          v-else-if="
            activeMode === 'diff' && originalContent !== undefined && currentContent !== undefined
          "
          :original="originalContent"
          :current="currentContent"
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
        />
      </div>
    </template>
  </div>
</template>
