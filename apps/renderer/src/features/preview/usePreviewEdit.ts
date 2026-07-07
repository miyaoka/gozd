/**
 * Preview の編集オーケストレーション層。「いま編集を許可できる状態か」の判定と、
 * Edit / Save / Discard 操作を content 取得層 (`usePreviewContent`) の状態に接続する。
 *
 * 編集セッション自体の状態 (draft / dirty / 保存) は `usePreviewEditStore` が SSOT。
 * 本層はその入出力を preview の表示状態 (タブ / ファイル種別 / モード) と突き合わせる。
 */
import { computed, onUnmounted, watch } from "vue";
import { useCommandRegistry } from "../../shared/command";
import { useChangesSummaryStore } from "../changes";
import { usePrDiffToggleStore } from "../git-graph";
import { useWorktreeStore } from "../worktree";
import { useDiffEditor } from "./useDiffEditor";
import type { PreviewContent } from "./usePreviewContent";
import { usePreviewEditStore } from "./usePreviewEditStore";

export function usePreviewEdit(content: PreviewContent) {
  const worktreeStore = useWorktreeStore();
  const prDiffToggle = usePrDiffToggleStore();
  const summaryStore = useChangesSummaryStore();
  const editStore = usePreviewEditStore();
  const diffEditor = useDiffEditor();

  const {
    activeMode,
    isContentUnavailable,
    imageUrl,
    displayIsBinary,
    displayContent,
    fileType,
    previewEnabled,
    currentContent,
    originalContent,
    isCommitMode,
  } = content;

  /**
   * Current タブでコード編集可能な状態か。Edit ボタンの表示可否 (isEditable 経由) に使う。
   * template の CodePreview 描画条件をベースにしつつ、"current" モードだけに絞ったホワイトリスト
   * なので、template がそのまま描画する "original" (履歴表示、読み取り専用) はここでは false になる
   * ("original" では CodePreview は描画されるが編集は許可しない) — 単純な描画条件のミラーではない。
   *
   * `editStore.editMode` は意図的に条件に含めない。この computed は isEditable 経由で
   * 「編集を許可するか」自体を決める入力であり、editMode を条件に混ぜると自己参照になる
   * (編集中は CodePreview の代わりに CodeEditor が描画されるが、その間も Edit/Save/Discard の
   * 表示は維持したいため、「編集中でなければ CodePreview が描画されるはずの状態か」を判定する)。
   */
  const isCodePreviewActive = computed(() => {
    if (isContentUnavailable.value) return false;
    // "diff" だけでなく "original" (履歴表示) も除外する。ホワイトリストにすることで、
    // 将来 PreviewMode が増えても「編集可能なのは current だけ」の意図を構造的に保つ。
    if (activeMode.value !== "current") return false;
    if (imageUrl.value !== undefined) return false;
    if (displayIsBinary.value) return false;
    if (fileType.value === "markdown" && previewEnabled.value) return false;
    if (fileType.value === "html" && previewEnabled.value) return false;
    return displayContent.value !== undefined;
  });

  /** template の DiffPreview 描画条件をミラーした判定。isEditable の Diff タブ許可に使う。 */
  const isDiffPreviewActive = computed(() => {
    if (isContentUnavailable.value) return false;
    return (
      activeMode.value === "diff" &&
      originalContent.value !== undefined &&
      currentContent.value !== undefined
    );
  });

  /**
   * 編集可能か。対象は worktree 相対パスの実ファイル (`fsWriteFile` が dir + relPath でしか
   * 書けないため絶対パスは対象外)。commit / PR diff モードは git オブジェクトから取得した
   * 履歴表示なので編集対象にしない。Current タブ (CodeEditor) と Diff タブ (DiffPreview の
   * 右半身 inline 編集) の両方を対象とする。Original タブは履歴表示のため対象外。
   */
  const isEditable = computed(() => {
    if (worktreeStore.selection?.kind !== "worktreeRelative") return false;
    if (isCommitMode.value) return false;
    if (prDiffToggle.isOn) return false;
    return isCodePreviewActive.value || isDiffPreviewActive.value;
  });

  /** Save ボタンの活性判定。Current/Diff どちらも編集内容の SSOT は editStore.draftContent。 */
  const isDirty = computed(() => editStore.isDirty);

  function startEdit() {
    const dir = worktreeStore.dir;
    const relPath = worktreeStore.selectedRelPath;
    const text = currentContent.value;
    if (dir === undefined || relPath === undefined || text === undefined) return;
    editStore.startEdit(dir, relPath, text);
  }

  /**
   * editStore.discard() で draftContent を savedContent に戻す。Diff タブは Monaco の
   * modified model が別途その値を表示しているため、useDiffEditor().reset() で Monaco 側の
   * 表示内容も書き戻す (CodeEditor.vue は modelValue の watch で自動的に追従する)。
   */
  function discardEdit() {
    editStore.discard();
    if (activeMode.value === "diff") {
      const text = editStore.savedContent;
      if (text === undefined) return;
      diffEditor.reset(text);
    }
  }

  async function saveEdit() {
    const saved = await editStore.save();
    if (saved === undefined) return;
    // fsChange 到達を待たず楽観的に反映し、保存直後のチラつきを防ぐ。
    currentContent.value = saved;
  }

  /**
   * summary view は単一ファイル preview ごと unmount する (CodeEditor / DiffPreview の editable も
   * 含む) ため編集不可。summary 進入時に editMode を抜けないと、editStore.editMode が true のまま
   * 残って fsChange 抑止 (`if (editStore.editMode) return`) が効き続け、summary 表示中の対象ファイル
   * 外部変更が currentContent に反映されなくなる。
   */
  watch(
    () => summaryStore.enabled,
    (enabled) => {
      if (enabled) editStore.exitEditMode();
    },
  );

  /**
   * Cmd+S 保存コマンド。`saveEdit` (楽観更新込み) を handler にするため、`currentContent` に
   * アクセスできる本 composable 内で直接 register する (registerMarkdownHistoryCommands のような
   * MainLayout 経由の外部登録にすると currentContent への参照を渡す経路が必要になり複雑化する)。
   * PreviewPane は popover 要素として常時 mount される前提のため、onUnmounted は実質アプリ終了時のみ。
   *
   * 編集中でないときは何もせず false を返す。Cmd+S はブラウザ既定 (保存ダイアログ等) を
   * 「編集中のときだけ preventDefault で止める」挙動になり、他の textarea に
   * フォーカスがあっても奪わない。
   */
  const { register } = useCommandRegistry();
  const disposeSaveCommand = register("preview.save", {
    label: "Preview: Save File",
    precondition: "previewVisible",
    handler: () => {
      if (!editStore.editMode) return false;
      void saveEdit();
      return true;
    },
  });
  onUnmounted(disposeSaveCommand);

  return {
    isEditable,
    isDirty,
    startEdit,
    discardEdit,
    saveEdit,
  };
}
