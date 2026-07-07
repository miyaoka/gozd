<doc lang="md">
ファイルプレビューの統合コンテナ。選択ファイルの種別・モードに応じて preview leaf を切り替える。

## レイヤー構成（責務の置き場所）

- データ取得と表示状態の状態機械: `usePreviewContent`（uncommitted / commit / PR diff の 3 取得経路、
  非同期レース防止、fsChange 再取得、表示モード導出。契約の詳細は同 composable の docstring）
- blame / file history の rev 導出と popover 連携: `usePreviewRevs`
- 編集の可否判定と Edit / Save / Discard 操作: `usePreviewEdit`
- ヘッダ / モード切替ツールバーの表示ロジック: `PreviewHeader` / `PreviewToolbar`

本コンポーネントに残るのは leaf の切替（v-else-if 連鎖）と上記レイヤー間の配線だけ。

## プレビュー種別

拡張子 → 種別の対応表の SSOT は `previewFileType.ts`（docs/preview.md のファイル種別表と対応）。
子コンポーネントの内訳:

- コード → CodePreview（Shiki ハイライト）
- 差分 → DiffPreview（`git diff --no-index` で取得した hunk 配列を描画）
- 画像 / SVG → ImagePreview（ファイルサーバー URL）
- Markdown → MarkdownPreview（marked + DOMPurify）
- HTML → HtmlPreview（sandboxed `<iframe srcdoc>` でネイティブ描画）
</doc>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";
import { useChangesSummaryStore } from "../changes";
import { useWorktreeStore } from "../worktree";
import CodeEditor from "./CodeEditor.vue";
import CodePreview from "./CodePreview.vue";
import DiffPreview from "./DiffPreview.vue";
import { ChangesSummaryView } from "./features/changes-summary";
import { useBlamePopover, useFileHistoryPopover } from "./features/commit-history";
import { MarkdownPreview } from "./features/markdown";
import HtmlPreview from "./HtmlPreview.vue";
import ImagePreview from "./ImagePreview.vue";
import { previewCodeFontFamily, previewFontFamily, previewFontSize } from "./previewConfig";
import PreviewHeader from "./PreviewHeader.vue";
import PreviewToolbar from "./PreviewToolbar.vue";
import { resolveOpenablePath } from "./resolveOpenablePath";
import { usePreviewContent } from "./usePreviewContent";
import { usePreviewEdit } from "./usePreviewEdit";
import { usePreviewEditStore } from "./usePreviewEditStore";
import { usePreviewRevs } from "./usePreviewRevs";
import { usePreviewStore } from "./usePreviewStore";
import IconLucidePencil from "~icons/lucide/pencil";

const emit = defineEmits<{
  close: [];
}>();

const worktreeStore = useWorktreeStore();
const { selectedDisplayPath, selectedLineNumber, revealVersion } = storeToRefs(worktreeStore);
const summaryStore = useChangesSummaryStore();
const previewStore = usePreviewStore();
const editStore = usePreviewEditStore();

const blamePopover = useBlamePopover();
const fileHistoryPopover = useFileHistoryPopover();

const content = usePreviewContent({
  // content 再取得で CodePreview / DiffPreview の line-no button DOM が置換され popover anchor が
  // detach するため、再 fetch 前に同 file の popover を閉じる (onBeforeRefetch 契約)。
  onBeforeRefetch: (dir, relPath) => {
    blamePopover.closeIfActive(dir, relPath);
    fileHistoryPopover.closeIfActive(dir, relPath);
  },
});
const {
  fileType,
  previewEnabled,
  activeMode,
  availableModes,
  originalHashLabel,
  loading,
  error,
  isDirectory,
  isNotFound,
  currentContent,
  originalContent,
  displayContent,
  displayIsBinary,
  effectiveGitChange,
  imageUrl,
} = content;

const { blameEnabled, fileCommitDateProps, onCodeLineClick, onDiffLineClick } =
  usePreviewRevs(content);
const { isEditable, isDirty, startEdit, discardEdit, saveEdit } = usePreviewEdit(content);

/** コード折り返しトグル */
const wordWrap = ref(true);

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
 * 表示中ファイルを OS のデフォルトアプリで開く入力に使う実 (working tree) 絶対パス。
 * working tree に実体が無い (notFound / deleted) ケースは undefined を返し、ボタン描画自体を
 * gate して silent dead button を作らない。解決ロジックは純関数 `resolveOpenablePath` に切り出す。
 */
const openableAbsPath = computed<string | undefined>(() =>
  resolveOpenablePath({
    selection: worktreeStore.selection,
    dir: worktreeStore.dir,
    isNotFound: isNotFound.value,
    effectiveGitChange: effectiveGitChange.value,
  }),
);
</script>

<template>
  <ChangesSummaryView v-if="summaryStore.enabled" @close="previewStore.close()" />

  <div v-else class="flex h-full flex-col overflow-hidden">
    <!-- ヘッダー（常に表示） -->
    <PreviewHeader
      :file-commit-date-props="fileCommitDateProps"
      :openable-abs-path="openableAbsPath"
      @close="emit('close')"
    />

    <!-- 未選択 -->
    <div
      v-if="!selectedDisplayPath"
      class="flex flex-1 items-center justify-center text-sm text-foreground-low"
    >
      Select a file to preview
    </div>

    <!-- 選択中 -->
    <template v-else>
      <PreviewToolbar
        v-model:active-mode="activeMode"
        v-model:preview-enabled="previewEnabled"
        v-model:word-wrap="wordWrap"
        :modes="availableModes"
        :original-hash-label="originalHashLabel"
        :file-type="fileType"
      />

      <!-- 編集ツールバー: コード領域右上にフローティング。スクロールで流れないよう
           外側の relative ラッパー (overflow-hidden) を基準に固定する。
           Exit (モードを抜けるだけの表示操作) と Discard/Save (データ操作) はセパレーターで
           グループを分け、Discard/Save はテキスト + 色でフォームの cancel/submit パターンに
           揃える。真逆の破壊的アクションである save/discard を
           アイコンだけの小さなボタンで隣接させると誤操作しやすいため、ラベルと視覚的な重み
           (Save = primary 塗りつぶし、Discard = 地味なテキスト) の非対称性で区別する。 -->
      <div class="relative min-h-0 flex-1">
        <!-- Edit/Exit と Discard/Save は別々のグループ (別 div) にする。
             外側 flex ラッパーは items-center で子を縦センタリングするため、2 グループの
             高さが揃っていないと、編集モードの有無でどちらか高い方に再センタリングされ
             縦にずれる (Save ボタンの padding だけ高さが違うと発生する)。これを構造的に
             防ぐため、両グループとも中身の padding に依存せず同じ明示的な高さ (h-7) にする。 -->
        <div v-if="isEditable" class="absolute top-2 right-4 z-10 flex items-center gap-2">
          <!-- Discard/Save グループ: Edit/Exit トグルとは独立 -->
          <div
            v-if="editStore.editMode"
            class="flex h-7 items-center gap-2 rounded-md border border-border bg-panel px-2 shadow-sm"
          >
            <button
              type="button"
              class="text-xs text-foreground-low hover:text-foreground disabled:cursor-default disabled:text-foreground-muted disabled:hover:text-foreground-muted"
              :disabled="!isDirty"
              title="Discard changes"
              aria-label="Discard changes"
              @click="discardEdit()"
            >
              Discard
            </button>
            <button
              type="button"
              class="rounded-sm bg-primary px-2 py-0.5 text-xs text-foreground hover:bg-primary-hover disabled:bg-element disabled:text-foreground-muted disabled:hover:bg-element"
              :disabled="!isDirty || editStore.saving"
              title="Save (Cmd+S)"
              aria-label="Save"
              @click="saveEdit()"
            >
              Save
            </button>
          </div>

          <!-- Edit / Exit トグルグループ: 同じ状態のトグル。同じボタン・同じ位置でラベルだけ切り替える -->
          <div
            class="flex h-7 items-center rounded-md border border-border bg-panel px-2 shadow-sm"
          >
            <button
              type="button"
              class="flex items-center gap-1 text-xs text-foreground-low hover:text-foreground"
              :title="editStore.editMode ? 'Exit edit mode' : 'Edit file'"
              :aria-label="editStore.editMode ? 'Exit edit mode' : 'Edit file'"
              @click="editStore.editMode ? editStore.exitEditMode() : startEdit()"
            >
              <IconLucidePencil class="size-3.5" />
              {{ editStore.editMode ? "Exit" : "Edit" }}
            </button>
          </div>
        </div>

        <!--
          コンテンツ。Cmd+A scope は各 leaf (CodePreview / MarkdownPreview / DiffPreview) 側の
          contenteditable で完結させる。PreviewPane 側はラッパとしてのみ振る舞い、contenteditable
          を持たないことで nested editing host の不安定領域を踏まない。
        -->
        <div
          class="size-full overflow-auto"
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
            :editable="editStore.editMode && isEditable"
            @line-number-click="onDiffLineClick"
            @cancel="editStore.exitEditMode()"
            @update:model-value="editStore.updateDraft($event)"
          />

          <!-- 画像プレビュー（バイナリ画像 + SVG preview モード）。worktree 外の絶対パスも /abs 経路で配信 -->
          <ImagePreview
            v-else-if="imageUrl"
            :src="imageUrl"
            @error="error = 'Failed to load image'"
          />

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

          <!--
            編集モード: CodePreview の代わりにプレーンテキストエディタを表示。
            activeMode === 'current' も条件に含める。含めないと、Current タブで編集開始した後に
            Original タブへ切り替えても (editMode / draftContent は維持されたままなので)
            CodeEditor が Current の draft を描画し続けてしまう (isCodePreviewActive と同じ理由)。
          -->
          <CodeEditor
            v-else-if="
              editStore.editMode && editStore.draftContent !== undefined && activeMode === 'current'
            "
            :model-value="editStore.draftContent"
            :file-path="selectedDisplayPath ?? ''"
            :word-wrap="wordWrap"
            @update:model-value="editStore.updateDraft($event)"
            @cancel="editStore.exitEditMode()"
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
      </div>
    </template>
  </div>
</template>
