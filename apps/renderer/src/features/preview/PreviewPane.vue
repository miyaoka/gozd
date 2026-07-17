<doc lang="md">
ファイルプレビューの統合コンテナ。選択ファイルの種別・モードに応じて preview leaf を切り替える。

## レイヤー構成（責務の置き場所）

- データ取得と表示状態の状態機械: `usePreviewContent`（uncommitted / commit / PR diff の 3 取得経路、
  非同期レース防止、fsChange 再取得、表示モード導出。契約の詳細は同 composable の docstring）
- blame / file history の rev 導出と popover 連携: `usePreviewRevs`
- 編集の可否判定・編集セッション同期と Save / Discard 操作: `usePreviewEdit`
- ヘッダ / モード切替ツールバーの表示ロジック: `PreviewHeader` / `PreviewToolbar`
- 本文の leaf 切替 (v-else-if 連鎖): `PreviewContent`（pinned window と共有する表示 SSOT）
- 独立ウィンドウへの切り離し: ヘッダのドラッグ (しきい値超過) で raw source を
  スナップショット化して `usePinnedPreview` / PinnedPreviewLayer へ pin する
  (terminal の session preview popover と同じ操作感)。ドラッグ経路は pin 元の rect と
  掴んだ pointer を `PinDragHandoff` でウィンドウへ引き継ぎ、pane を掴んでそのまま
  引き剥がす操作感にする。pin 後は popover を閉じる (二重表示を残さない)

本コンポーネントに残るのは上記レイヤー間の配線だけ。

## プレビュー種別

拡張子 → 種別の対応表の SSOT は `previewFileType.ts`（docs/preview.md のファイル種別表と対応）。
leaf コンポーネントの内訳 (`PreviewContent` 配下):

- コード → CodePreview（Monaco + Shiki TextMate ハイライト。編集可能ファイルは常時編集状態）
- 差分 → DiffPreview（`git diff --no-index` で取得した hunk 配列を描画）
- 画像 / SVG → ImagePreview（取得済み content から Blob → ObjectURL）
- Markdown → MarkdownPreview（marked + DOMPurify）
- HTML → HtmlPreview（sandboxed `<iframe srcdoc>` でネイティブ描画）
</doc>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, ref, useTemplateRef, watch } from "vue";
import { useRepoStore } from "../../shared/repo";
import { useChangesSummaryStore } from "../changes";
import type { PinDragHandoff } from "../floating-window";
import { usePrDiffToggleStore } from "../git-graph";
import { UNCOMMITTED_HASH, useWorktreeStore } from "../worktree";
import { ChangesSummaryView } from "./features/changes-summary";
import { useBlamePopover, useFileHistoryPopover } from "./features/commit-history";
import PreviewContent from "./PreviewContent.vue";
import PreviewHeader from "./PreviewHeader.vue";
import PreviewToolbar from "./PreviewToolbar.vue";
import { resolveOpenablePath } from "./resolveOpenablePath";
import {
  usePinnedPreview,
  type PinnedPreviewDoc,
  type PinnedPreviewSource,
} from "./usePinnedPreview";
import { usePreviewContent } from "./usePreviewContent";
import { usePreviewEdit } from "./usePreviewEdit";
import { usePreviewEditStore } from "./usePreviewEditStore";
import { usePreviewRevs } from "./usePreviewRevs";
import { usePreviewStore } from "./usePreviewStore";

const emit = defineEmits<{
  close: [];
}>();

const worktreeStore = useWorktreeStore();
const repoStore = useRepoStore();
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
  isContentUnavailable,
  currentContent,
  originalContent,
  currentText,
  originalText,
  displayContent,
  displayIsBinary,
  isBinary,
  effectiveGitChange,
  imageSource,
  contentEpoch,
  isCommitMode,
  orderedRange,
} = content;

/**
 * 画像描画失敗 (壊れた bytes 等) の error 表示。content 層の error (fetch 失敗) に畳むと
 * rev 切替 (Current ↔ Original) で正常に描ける側まで error 表示が固定されるため分離し、
 * view 操作と content 更新 (contentEpoch) でリセットする (PinnedPreviewWindow と同じ規律)。
 */
const imageError = ref(false);
watch([activeMode, previewEnabled, contentEpoch], () => {
  imageError.value = false;
});
const displayError = computed<string | undefined>(
  () => error.value ?? (imageError.value ? "Failed to load image" : undefined),
);

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
 * (VS Code の diff editor がバッファを表示するのと同じ意味論)。diff はテキスト面のみ
 * (バイナリは currentText が undefined になり diff leaf 自体が出ない)。
 */
const diffCurrent = computed<string | undefined>(() => {
  if (!isEditable.value) return currentText.value;
  return editStore.draftContent ?? currentText.value;
});

/** コード折り返しトグル */
const wordWrap = ref(true);

// ==== 独立ウィンドウへの切り離し (pin) ====

const { pin: pinPreviewWindow } = usePinnedPreview();

const prDiffToggle = usePrDiffToggleStore();

/**
 * pin 時点で current 側の中身が working tree の実ファイルかどうか。過去 rev の歴史表示
 * (commit / 範囲選択で newer が実 hash) を pin した window が live 追従・編集して
 * 「過去の内容で実ファイルを上書き保存する」事故を防ぐため、判定結果を焼き込む。
 * PR diff は to = working tree、範囲選択の Working Tree 端点も fs 読みなので true。
 * orderedRange 不整合 (null) は安全側 (固定・読み取り専用) に倒す。
 */
const currentIsWorkingTree = computed<boolean>(() => {
  if (prDiffToggle.isOn) return true;
  if (!isCommitMode.value) return true;
  return orderedRange.value?.newer === UNCOMMITTED_HASH;
});

// pin 時の実測対象。位置は pane 全体 (paneBox) の rect、サイズは本文領域 (paneBody) の
// rect を固定ウィンドウへ引き継ぎ、pane がその場でフローティング化したような視覚的
// 連続性を出す (総サイズでなく本文サイズを渡す理由は useFloatingWindows の doc 参照)。
const paneBoxRef = useTemplateRef<HTMLElement>("paneBox");
const paneBodyRef = useTemplateRef<HTMLElement>("paneBody");

/**
 * pin 時点の raw source (current / original の 2 rev の中身) をスナップショット化する。
 * テキストは string、バイナリは bytes で、意味論はどちらも「pin 時点に固定」。
 * 表示形は保存しない — window 側が doc + view 状態 (mode / preview / wrap) から都度導出
 * する (PinnedPreviewDoc の doc 参照)。表示が確定していない状態 (loading / directory /
 * notFound / error) と、表示可能な形 (テキスト or 画像) を 1 つも持たないファイル
 * (バイナリ非画像は placeholder しか出せない) は undefined で pin 不可に倒す
 * (ドラッグは無反応になる)。
 */
function buildPinnedDoc(): PinnedPreviewDoc | undefined {
  const path = selectedDisplayPath.value;
  if (path === undefined) return undefined;
  if (isContentUnavailable.value) return undefined;
  // current は編集可能ファイルなら draft を含む diffCurrent が SSOT。バイナリは raw bytes
  const current = isBinary.value ? currentContent.value : diffCurrent.value;
  const original = originalContent.value;
  const ft = fileType.value;
  const hasText = typeof current === "string" || typeof original === "string";
  if (!hasText && ft !== "image" && ft !== "svg") {
    return undefined;
  }
  return { filePath: path, current, original };
}

function detachPreview(handoff?: PinDragHandoff) {
  const path = selectedDisplayPath.value;
  const box = paneBoxRef.value;
  const body = paneBodyRef.value;
  if (path === undefined || box === null || body === null) return;
  // 「本体 preview として開き直す」ボタンの対象。pin 元の選択をそのまま焼き込む。
  // doc の画像 URL 構築にも使うため先に確定させる。
  const sel = worktreeStore.selection;
  const dir = worktreeStore.dir;
  const source: PinnedPreviewSource | undefined =
    sel === undefined
      ? undefined
      : sel.kind === "absolute"
        ? { kind: "absolute", absPath: sel.absPath }
        : dir === undefined
          ? undefined
          : { kind: "worktree", dir, relPath: sel.relPath };
  if (source === undefined) return;
  const doc = buildPinnedDoc();
  if (doc === undefined) return;
  const rect = box.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  // ヘッダ上段の出自 (repo + worktree branch)。pinned window は worktree 切替を跨いで
  // 生存するため pin 時点の値を焼き込む (PinnedLogWindow のヘッダと同じ規律)。
  // worktree 外の絶対パス (session log 等) は repo 帰属が無いので解決しない (空文字で
  // 上段ごと省かれる)。branch は WorktreeEntry のワイヤ契約どおり detached HEAD で空文字。
  const repo = source.kind === "worktree" ? repoStore.findRepoOwning(source.dir) : undefined;
  const branch = repo?.worktrees.find((wt) => wt.path === dir)?.branch ?? "";
  pinPreviewWindow(
    {
      repoName: repo?.repoName ?? "",
      repoOwner: repo?.githubIdentity?.owner ?? "",
      branch,
      fileName: path.split("/").pop() ?? path,
      displayPath: path,
      // モードタブは本体 availableModes の snapshot で再現する (window 側は git change
      // 種別を知らないため、判定結果だけを焼き込む)
      modes: [...availableModes.value],
      activeMode: activeMode.value,
      originalHashLabel: originalHashLabel.value,
      wordWrap: wordWrap.value,
      previewEnabled: previewEnabled.value,
      currentIsWorkingTree: currentIsWorkingTree.value,
      doc,
      source,
      x: rect.left,
      y: rect.top,
      bodyWidth: bodyRect.width,
      bodyHeight: bodyRect.height,
    },
    handoff,
  );
  // pin 後は popover を閉じる (二重表示を残さない)。close 経路は MainLayout →
  // previewStore.close() で、ヘッダの close ボタンと同じ意味論。
  emit("close");
}

/** ヘッダのドラッグを pin 化とみなすしきい値 (px)。ヘッダ内ボタンのクリックと区別する。 */
const DRAG_PIN_THRESHOLD = 4;

// ヘッダのドラッグ検知。しきい値を超えたら pin して、掴んでいる pointer ごと
// PinnedPreviewWindow へドラッグを引き継ぐ (PinDragHandoff)。pin は rect を実測してから
// popover を閉じるので、ウィンドウは掴んだその位置に現れてそのまま動かせる
// (TerminalSessionPreview の全文 popover と同じ流儀)。
let headerDrag: { pointerId: number; startX: number; startY: number } | undefined;

function onHeaderPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  // ヘッダ内のボタン (back / forward / ⋮ / close) 起点はボタン操作。ドラッグ判定に乗せない
  if (event.target instanceof Element && event.target.closest("button") !== null) return;
  const header = event.currentTarget;
  if (!(header instanceof HTMLElement)) return;
  // しきい値到達前に pointer がヘッダ外へ滑っても pointermove を受け続けるため capture する。
  // pin 発火後は popover が hide されるが要素は mount されたままなので、capture された
  // pointer の event は window までバブリングし FloatingWindow のドラッグ追従が継続する。
  header.setPointerCapture(event.pointerId);
  headerDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
}

function onHeaderPointerMove(event: PointerEvent) {
  if (headerDrag === undefined || event.pointerId !== headerDrag.pointerId) return;
  const dx = event.clientX - headerDrag.startX;
  const dy = event.clientY - headerDrag.startY;
  if (Math.hypot(dx, dy) < DRAG_PIN_THRESHOLD) return;
  const box = paneBoxRef.value;
  if (box === null) return;
  // オフセットは掴んだ瞬間 (pointerdown) の位置基準。しきい値超過時点の位置基準にすると
  // 引き継ぎ直後にしきい値分だけウィンドウが跳ねる。
  const rect = box.getBoundingClientRect();
  const grab = headerDrag;
  headerDrag = undefined;
  detachPreview({
    pointerId: event.pointerId,
    offsetX: grab.startX - rect.left,
    offsetY: grab.startY - rect.top,
  });
}

function onHeaderPointerUp(event: PointerEvent) {
  if (headerDrag?.pointerId !== event.pointerId) return;
  headerDrag = undefined;
}

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

  <div v-else ref="paneBox" class="flex h-full flex-col overflow-hidden">
    <!-- ヘッダー（常に表示）。ボタン以外の領域のドラッグ (しきい値超過) で表示中
         コンテンツを独立フローティングウィンドウへ切り離す -->
    <div
      class="shrink-0 cursor-grab select-none active:cursor-grabbing"
      title="Drag to pin as floating window"
      @pointerdown="onHeaderPointerDown"
      @pointermove="onHeaderPointerMove"
      @pointerup="onHeaderPointerUp"
      @pointercancel="onHeaderPointerUp"
    >
      <PreviewHeader
        :file-commit-date-props="fileCommitDateProps"
        :openable-abs-path="openableAbsPath"
        @close="emit('close')"
      />
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
      <div ref="paneBody" class="relative min-h-0 flex-1">
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
          コンテンツ。leaf 切替の実体は PreviewContent (pinned window と共有する表示 SSOT)。
          ここは live なデータ源 (usePreviewContent) と編集 / blame の文脈を配線するだけ。
          Cmd+A scope は各 leaf 側で完結させる (MarkdownPreview / DiffPreview は
          contenteditable、CodePreview は Monaco 自身の selection)。
        -->
        <PreviewContent
          class="size-full"
          :file-path="selectedDisplayPath"
          :file-type="fileType"
          :active-mode="activeMode"
          :preview-enabled="previewEnabled"
          :word-wrap="wordWrap"
          :original-content="originalText"
          :diff-current="diffCurrent"
          :code-content="codeContent"
          :display-content="displayContent"
          :image-source="imageSource"
          :display-is-binary="displayIsBinary"
          :loading="loading"
          :is-directory="isDirectory"
          :is-not-found="isNotFound"
          :error="displayError"
          :line-number="selectedLineNumber"
          :reveal-version="revealVersion"
          :blame-enabled="blameEnabled"
          :editable="isEditable"
          @code-line-click="onCodeLineClick"
          @diff-line-click="onDiffLineClick"
          @update-content="editStore.updateDraft($event)"
          @scrolled="onCodeScrolled"
          @image-error="imageError = true"
        />
      </div>
    </template>
  </div>
</template>
