<doc lang="md">
プレビュー本文 (leaf 切替) の表示 SSOT。

「どの leaf をどの条件で描くか」の v-else-if 連鎖を本体 (PreviewPane) と pinned window
(PinnedPreviewWindow) で共有する presentational コンポーネント。store には触れず、
データは props、操作は emit のみ。データ源が live (`usePreviewContent`) か snapshot
(`PinnedPreviewDoc`) かは呼び出し側の関心で、表示は「同じ入力 → 同じ UI」を構造的に
保証する (view の切り離しで UI が縮小・分岐しないための境界)。

- 編集 / blame / 行番号 reveal は capability props (editable / blameEnabled / lineNumber /
  revealVersion)。対応する文脈を持たない呼び出し側 (pinned window) は default の
  無効値のまま使う
- フォント設定 (previewConfig) の適用もここに含める (本体と pinned でフォントが
  食い違わないように)。root は overflow-auto のみ持ち、サイズ決定 (size-full /
  min-h-0 flex-1 等) は呼び出し側の class fallthrough に委ねる
- 画像の load 失敗は imageError を emit するだけで、error 表示への反映 (error prop) は
  呼び出し側が決める (本体は content 層の error ref、pinned はローカル ref)
</doc>

<script setup lang="ts">
import CodePreview from "./CodePreview.vue";
import DiffPreview from "./DiffPreview.vue";
import { MarkdownPreview } from "./features/markdown";
import HtmlPreview from "./HtmlPreview.vue";
import ImagePreview from "./ImagePreview.vue";
import { previewCodeFontFamily, previewFontFamily, previewFontSize } from "./previewConfig";
import type { FileType } from "./previewFileType";
import type { PreviewMode } from "./previewMode";

withDefaults(
  defineProps<{
    filePath: string;
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
    /** 画像表示 URL。previewEnabled off / 非画像は undefined を渡す契約 */
    imageUrl: string | undefined;
    displayIsBinary?: boolean;
    loading?: boolean;
    isDirectory?: boolean;
    isNotFound?: boolean;
    error?: string | undefined;
    /** スクロール・ハイライト対象の行番号 (1-based) */
    lineNumber?: number | undefined;
    /** 同一パス・同一行番号でもスクロールを再発火させるためのカウンタ */
    revealVersion?: number;
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
    revealVersion: 0,
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
    <ImagePreview v-else-if="imageUrl" :src="imageUrl" @error="emit('imageError')" />

    <!-- バイナリ（画像以外） -->
    <div v-else-if="displayIsBinary" class="p-4 text-sm text-foreground-low">
      Binary file — preview not available
    </div>

    <!-- Markdown preview モード -->
    <MarkdownPreview
      v-else-if="fileType === 'markdown' && previewEnabled && displayContent"
      :content="displayContent"
    />

    <!-- HTML preview モード（sandboxed iframe でネイティブ描画） -->
    <HtmlPreview
      v-else-if="fileType === 'html' && previewEnabled && displayContent"
      :content="displayContent"
    />

    <!-- コード表示・編集 -->
    <CodePreview
      v-else-if="codeContent !== undefined"
      :content="codeContent"
      :file-path="filePath"
      :line-number="lineNumber"
      :reveal-version="revealVersion"
      :word-wrap="wordWrap"
      :blame-enabled="blameEnabled"
      :editable="editable"
      @line-number-click="emit('codeLineClick', $event)"
      @scrolled="emit('scrolled')"
      @update:content="emit('updateContent', $event)"
    />
  </div>
</template>
