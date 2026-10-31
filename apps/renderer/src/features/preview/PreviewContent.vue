<script setup lang="ts">
import type { WireBytes } from "@gozd/rpc";
import CodePreview from "./CodePreview.vue";
import DiffPreview from "./DiffPreview.vue";
import { MarkdownPreview } from "./features/markdown";
import HtmlPreview from "./HtmlPreview.vue";
import ImagePreview from "./ImagePreview.vue";
import { previewCodeFontFamily, previewFontFamily, previewFontSize } from "./previewConfig";
import type { FileType } from "./previewFileType";
import type { PreviewMode } from "./previewMode";
import type { PreviewServingTarget } from "./previewServingTarget";

withDefaults(
  defineProps<{
    filePath: string;
    /** HTML preview 対象の絶対パス。html 以外では undefined */
    htmlAbsPath?: string;
    /** HTML preview の配信を許す root（対象が属する worktree root）。html 以外では undefined */
    htmlRoot?: string;
    /** content 更新のカウンタ。増えると HTML preview が iframe を再 load する */
    htmlEpoch?: number;
    /** markdown の画像の配信対象。markdown 以外では undefined */
    markdownTarget?: PreviewServingTarget;
    fileType: FileType;
    activeMode: PreviewMode;
    previewEnabled: boolean;
    wordWrap: boolean;
    /** diff の from 側テキスト */
    originalContent: string | undefined;
    /** diff の to 側テキスト (編集可能ファイルは draft 込みを親が渡す) */
    diffCurrent: string | undefined;
    /** code leaf の内容 (編集可能ファイルは draft 込み)。undefined なら code leaf を出さない */
    codeContent: string | undefined;
    /** markdown / html の rendered 元テキスト (activeMode 解決済み) */
    displayContent: string | undefined;
    /** 画像 / SVG の中身 (バイナリ画像は bytes、SVG はテキスト)。previewEnabled off /
     * 非画像は undefined を渡す契約 */
    imageSource: string | WireBytes | undefined;
    displayIsBinary?: boolean;
    loading?: boolean;
    isDirectory?: boolean;
    isNotFound?: boolean;
    error?: string | undefined;
    /** スクロール・ハイライト対象の行番号 (1-based) */
    lineNumber?: number | undefined;
    /** 同一パス・同一行番号でもスクロールを再発火させるためのカウンタ */
    selectPathVersion?: number;
    blameEnabled?: boolean;
    editable?: boolean;
  }>(),
  {
    displayIsBinary: false,
    loading: false,
    isDirectory: false,
    isNotFound: false,
    error: undefined,
    lineNumber: undefined,
    selectPathVersion: 0,
    blameEnabled: false,
    editable: false,
  },
);

const emit = defineEmits<{
  codeLineClick: [payload: { line: number; anchorEl: HTMLElement }];
  diffLineClick: [payload: { side: "old" | "new"; line: number; anchorEl: HTMLElement }];
  scrolled: [];
  /** editable 時の編集内容 (code / diff どちらの経路でも全文)。親が editStore.updateDraft に流す */
  updateContent: [value: string];
  imageError: [];
}>();
</script>

<template>
  <div
    class="overflow-auto"
    :style="{
      fontFamily: previewFontFamily || undefined,
      fontSize: previewFontSize > 0 ? `${previewFontSize}px` : undefined,
      '--preview-code-font-family': previewCodeFontFamily || undefined,
    }"
  >
    <div v-if="loading" class="p-4 text-sm text-foreground-low">Loading...</div>

    <div v-else-if="isDirectory" class="p-4 text-sm text-foreground-low">Directory</div>

    <div v-else-if="isNotFound" class="p-4 text-sm text-foreground-low">File not found</div>

    <div v-else-if="error" class="p-4 text-sm text-destructive-text">{{ error }}</div>

    <!-- diff モード。編集可能ファイルは Monaco diff editor (modified 側が常時編集可) -->
    <DiffPreview
      v-else-if="
        activeMode === 'diff' && originalContent !== undefined && diffCurrent !== undefined
      "
      :original="originalContent"
      :current="diffCurrent"
      :file-path="filePath"
      :word-wrap="wordWrap"
      :blame-enabled="blameEnabled"
      :editable="editable"
      @line-number-click="emit('diffLineClick', $event)"
      @update:current="emit('updateContent', $event)"
      @scrolled="emit('scrolled')"
    />

    <!-- 画像プレビュー（バイナリ画像 + SVG preview モード） -->
    <ImagePreview
      v-else-if="imageSource !== undefined"
      :source="imageSource"
      :file-path="filePath"
      @error="emit('imageError')"
    />

    <!-- バイナリ（画像以外） -->
    <div v-else-if="displayIsBinary" class="p-4 text-sm text-foreground-low">
      Binary file — preview not available
    </div>

    <!-- Markdown preview モード -->
    <MarkdownPreview
      v-else-if="fileType === 'markdown' && previewEnabled && displayContent"
      :content="displayContent"
      :target="markdownTarget"
    />

    <!-- HTML preview モード（main の配信 scheme 経由で実 URL を load する） -->
    <HtmlPreview
      v-else-if="
        fileType === 'html' && previewEnabled && htmlAbsPath !== undefined && htmlRoot !== undefined
      "
      :abs-path="htmlAbsPath"
      :root="htmlRoot"
      :epoch="htmlEpoch ?? 0"
    />

    <!-- コード表示・編集 -->
    <CodePreview
      v-else-if="codeContent !== undefined"
      :content="codeContent"
      :file-path="filePath"
      :line-number="lineNumber"
      :select-path-version="selectPathVersion"
      :word-wrap="wordWrap"
      :blame-enabled="blameEnabled"
      :editable="editable"
      @line-number-click="emit('codeLineClick', $event)"
      @scrolled="emit('scrolled')"
      @update:content="emit('updateContent', $event)"
    />
  </div>
</template>
