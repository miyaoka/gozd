/**
 * Preview の編集オーケストレーション層。「いま編集を許可できる状態か」の判定と、
 * 編集セッションの自動同期 / Save / Discard 操作を content 取得層 (`usePreviewContent`) の
 * 状態に接続する。
 *
 * 判定ロジックの実体は `previewEditPolicy.ts` (純粋関数、bun test 対象)。本 composable は
 * store / ref から snapshot を組んで policy に渡し、結果を watch / computed / コマンド登録に
 * 配線するだけの層で、それ自体はテストしない。
 *
 * 編集セッション自体の状態 (draft / dirty / 保存) は `usePreviewEditStore` が SSOT。
 * 明示的な edit mode は存在せず、編集可能な content が表示されたら自動でセッションを張る
 * (常時編集。Edit ボタンは無い)。
 */
import { computed, onScopeDispose, watch } from "vue";
import { useCommandRegistry } from "../../shared/command";
import { useChangesSummaryStore } from "../changes";
import { usePrDiffToggleStore } from "../git-graph";
import { useWorktreeStore } from "../worktree";
import { isEditablePreview, resolveSessionTarget } from "./previewEditPolicy";
import type { PreviewContentSnapshot } from "./previewEditPolicy";
import type { PreviewContent } from "./usePreviewContent";
import { usePreviewEditStore } from "./usePreviewEditStore";
import { usePreviewStore } from "./usePreviewStore";

export function usePreviewEdit(content: PreviewContent) {
  const worktreeStore = useWorktreeStore();
  const prDiffToggle = usePrDiffToggleStore();
  const summaryStore = useChangesSummaryStore();
  const editStore = usePreviewEditStore();
  const previewStore = usePreviewStore();

  const {
    activeMode,
    isContentUnavailable,
    imageSource,
    displayIsBinary,
    displayContent,
    fileType,
    previewEnabled,
    currentContent,
    currentText,
    originalText,
    isCommitMode,
  } = content;

  const snapshot = computed<PreviewContentSnapshot>(() => ({
    isContentUnavailable: isContentUnavailable.value,
    activeMode: activeMode.value,
    hasImage: imageSource.value !== undefined,
    displayIsBinary: displayIsBinary.value,
    fileType: fileType.value,
    previewEnabled: previewEnabled.value,
    hasDisplayContent: displayContent.value !== undefined,
    hasOriginalText: originalText.value !== undefined,
    hasCurrentText: currentText.value !== undefined,
  }));

  const isEditable = computed(() =>
    isEditablePreview(
      {
        selectionKind: worktreeStore.selection?.kind,
        isCommitMode: isCommitMode.value,
        prDiffOn: prDiffToggle.isOn,
      },
      snapshot.value,
    ),
  );

  /** Save / Discard ボタンの活性判定。編集内容の SSOT は editStore.draftContent。 */
  const isDirty = computed(() => editStore.isDirty);

  /**
   * 編集セッションの自動同期 (不変条件の「張る」側は `resolveSessionTarget` 参照)。畳む側は
   * usePreviewStore.close() の endSession (popover 閉) と下の summary watch (summary 進入)、
   * 対象切替は usePreviewContent の main watch が endSession で先に畳む。
   *
   * isOpen / summary.enabled をソースに含めるのは張り直しのため: close は endSession で
   * セッションを破棄するが、再 open では isEditable / currentText が変化しない (popover の
   * hide は unmount ではなく selection も content も残る) ので、可視状態の変化そのものを
   * 発火源にしないとセッション不在のまま編集が updateDraft のセッション外ガードで
   * 捨てられ続ける。summary 退出も同型 (enabled が false に戻るだけで content は不変)。
   *
   * `beginSession` は「同一 target + 保存済み内容一致」なら no-op で dirty draft を保持する
   * ため、タブ切替 (current → original → current) やこの watch の再発火で未保存の編集は
   * 失われない。
   */
  watch(
    [() => previewStore.isOpen, () => summaryStore.enabled, isEditable, currentText] as const,
    ([open, summaryEnabled, editable, text]) => {
      const target = resolveSessionTarget({
        open,
        summaryEnabled,
        editable,
        text,
        selection: worktreeStore.selection,
        dir: worktreeStore.dir,
        relPath: worktreeStore.selectedRelPath,
      });
      // text の undefined は resolveSessionTarget 内で弾かれているが、型上ここでも絞る
      if (target === undefined || text === undefined) return;
      editStore.beginSession(target, text);
    },
    { immediate: true },
  );

  /** 未保存の変更を保存済み内容に戻す */
  function discardEdit() {
    editStore.discard();
  }

  async function saveEdit() {
    const saved = await editStore.save();
    if (saved === undefined) return;
    // fsChange 到達を待たず楽観的に反映し、保存直後のチラつきを防ぐ。
    currentContent.value = saved;
  }

  /**
   * summary view は単一ファイル preview ごと unmount するため編集不可。summary 進入時に
   * セッションを畳まないと、dirty な draft が残って fsChange 抑止 (`if (editStore.isDirty)
   * return`) が効き続け、summary 表示中の対象ファイル外部変更が currentContent に反映され
   * なくなる。
   */
  watch(
    () => summaryStore.enabled,
    (enabled) => {
      if (enabled) editStore.endSession();
    },
  );

  /**
   * Cmd+S 保存コマンド。`saveEdit` (楽観更新込み) を handler にするため、`currentContent` に
   * アクセスできる本 composable 内で直接 register する (registerMarkdownHistoryCommands のような
   * MainLayout 経由の外部登録にすると currentContent への参照を渡す経路が必要になり複雑化する)。
   * PreviewPane は popover 要素として常時 mount される前提のため、dispose は実質アプリ終了時のみ。
   * 解除は onScopeDispose に掛ける (component の setup scope は unmount で停止するため挙動は
   * onUnmounted と同一。component インスタンス非依存で lifecycle を持ち込まない)。
   *
   * 編集セッションが無いときは何もせず false を返す。Cmd+S はブラウザ既定 (保存ダイアログ等) を
   * 「セッションがあるときだけ preventDefault で止める」挙動になり、他の textarea に
   * フォーカスがあっても奪わない。
   */
  const { register } = useCommandRegistry();
  const disposeSaveCommand = register("preview.save", {
    label: "Preview: Save File",
    precondition: "previewVisible",
    handler: () => {
      if (!editStore.hasSession) return false;
      void saveEdit();
      return true;
    },
  });
  onScopeDispose(disposeSaveCommand);

  return {
    isEditable,
    isDirty,
    discardEdit,
    saveEdit,
  };
}
