<doc lang="md">
ファイルプレビューの統合コンテナ。選択ファイルの種別・モードに応じて preview leaf を切り替える。

## レイヤー構成（責務の置き場所）

- データ取得と表示状態の状態機械: `usePreviewContent`（uncommitted / commit / PR diff の 3 取得経路、
  非同期レース防止、fsChange 再取得、表示モード導出。契約の詳細は同 composable の docstring）
- blame / file history の rev 導出と popover 連携: `usePreviewRevs`
- 編集の可否判定・編集セッション同期と Save / Discard 操作: `usePreviewEdit`
- ヘッダ / モード切替ツールバーの表示ロジック: `PreviewHeader` / `PreviewToolbar`

本コンポーネントに残るのは leaf の切替（v-else-if 連鎖）と上記レイヤー間の配線だけ。

## プレビュー種別

拡張子 → 種別の対応表の SSOT は `previewFileType.ts`（docs/preview.md のファイル種別表と対応）。
子コンポーネントの内訳:

- コード → CodePreview（Monaco + Shiki TextMate ハイライト。編集可能ファイルは常時編集状態）
- 差分 → DiffPreview（`git diff --no-index` で取得した hunk 配列を描画）
- 画像 / SVG → ImagePreview（ファイルサーバー URL）
- Markdown → MarkdownPreview（marked + DOMPurify）
- HTML → HtmlPreview（sandboxed `<iframe srcdoc>` でネイティブ描画）
</doc>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref, watch } from "vue";
import { useChangesSummaryStore } from "../changes";
import { useWorktreeStore } from "../worktree";
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
const { isEditable, isDirty, discardEdit, saveEdit } = usePreviewEdit(content);

/**
 * コード leaf に渡す内容。編集可能なら編集セッションの draft (SSOT)、読み取り専用なら
 * 取得済みの表示内容。セッション同期 (usePreviewEdit の watch) が張るまでの 1 tick は
 * displayContent に fallback する (同一内容なのでチラつかない)。
 */
const codeContent = computed<string | undefined>(() => {
  if (!isEditable.value) return displayContent.value;
  return editStore.draftContent ?? displayContent.value;
});

/**
 * Diff タブの current 側。編集可能なら draft (SSOT) を渡し、未保存の編集も diff に反映する
 * (VS Code の diff editor がバッファを表示するのと同じ意味論)。
 */
const diffCurrent = computed<string | undefined>(() => {
  if (!isEditable.value) return currentContent.value;
  return editStore.draftContent ?? currentContent.value;
});

/** コード折り返しトグル */
const wordWrap = ref(true);

/**
 * Monaco chunk (数 MB) のアイドル先読み。初回のコードプレビューで dynamic import を待つと
 * Monaco 描画までプレーンテキスト fallback が数百 ms 見えるため、起動直後のアイドル時間に
 * import して chunk の評価まで済ませておく。PreviewPane は popover 要素として常時 mount
 * される前提 (usePreviewEdit の save コマンド登録と同じ) なので、ここが 1 回だけ走る
 * 先読みの置き場になる。
 */
onMounted(() => {
  requestIdleCallback(() => {
    void import("./monacoSetup");
  });
});

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

/**
 * CodePreview (Monaco) のスクロールで blame popover を閉じる。blame anchor は
 * クリック時の位置に固定した自前要素のため、スクロールすると行とずれた位置を指し続ける
 * (CodePreview の doc 参照)。file history popover はヘッダ anchored なので閉じない。
 */
function onCodeScrolled() {
  if (blamePopover.context.value !== undefined) {
    blamePopover.close();
  }
}
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

      <!-- 保存ツールバー: コード領域右上にフローティング。スクロールで流れないよう
           外側の relative ラッパー (overflow-hidden) を基準に固定する。
           編集可能ファイルは常時編集状態のため Edit/Exit トグルは存在せず、未保存の変更が
           あるときだけ Discard/Save を出す (クリーン時に常時出すとただのノイズになる)。
           真逆の破壊的アクションである save/discard をアイコンだけの小さなボタンで
           隣接させると誤操作しやすいため、ラベルと視覚的な重み (Save = primary 塗りつぶし、
           Discard = 地味なテキスト) の非対称性で区別する。 -->
      <div class="relative min-h-0 flex-1">
        <div
          v-if="isEditable && isDirty"
          class="absolute top-2 right-4 z-10 flex h-7 items-center gap-2 rounded-md border border-border bg-panel px-2 shadow-sm"
        >
          <button
            type="button"
            class="text-xs text-foreground-low hover:text-foreground"
            title="Discard changes"
            aria-label="Discard changes"
            @click="discardEdit()"
          >
            Discard
          </button>
          <button
            type="button"
            class="rounded-sm bg-primary px-2 py-0.5 text-xs text-foreground hover:bg-primary-hover disabled:bg-element disabled:text-foreground-muted disabled:hover:bg-element"
            :disabled="editStore.saving"
            title="Save (Cmd+S)"
            aria-label="Save"
            @click="saveEdit()"
          >
            Save
          </button>
        </div>

        <!--
          コンテンツ。Cmd+A scope は各 leaf 側で完結させる (MarkdownPreview / DiffPreview は
          contenteditable、CodePreview は Monaco 自身の selection)。PreviewPane 側は
          ラッパとしてのみ振る舞い、contenteditable を持たないことで nested editing host の
          不安定領域を踏まない。
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

          <!-- diff モード。編集可能ファイルは Monaco diff editor (modified 側が常時編集可) -->
          <DiffPreview
            v-else-if="
              activeMode === 'diff' && originalContent !== undefined && diffCurrent !== undefined
            "
            :original="originalContent"
            :current="diffCurrent"
            :file-path="selectedDisplayPath ?? ''"
            :word-wrap="wordWrap"
            :blame-enabled="blameEnabled"
            :editable="isEditable"
            @line-number-click="onDiffLineClick"
            @update:current="editStore.updateDraft($event)"
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

          <!-- コード表示・編集。編集可能ファイル (isEditable) は常時編集状態で、内容は
               editStore.draftContent が SSOT (codeContent 参照)。読み取り専用 (Original タブ /
               commit・PR diff モード等) は displayContent をそのまま表示する。 -->
          <CodePreview
            v-else-if="codeContent !== undefined"
            :content="codeContent"
            :file-path="selectedDisplayPath"
            :line-number="selectedLineNumber"
            :reveal-version="revealVersion"
            :word-wrap="wordWrap"
            :blame-enabled="blameEnabled"
            :editable="isEditable"
            @line-number-click="onCodeLineClick"
            @scrolled="onCodeScrolled"
            @update:content="editStore.updateDraft($event)"
          />
        </div>
      </div>
    </template>
  </div>
</template>
