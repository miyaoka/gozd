/**
 * Preview の編集オーケストレーション層。「いま編集を許可できる状態か」の判定と、
 * 編集セッションの自動同期 / Save / Discard 操作を content 取得層 (`usePreviewContent`) の
 * 状態に接続する。
 *
 * 編集セッション自体の状態 (draft / dirty / 保存) は `usePreviewEditStore` が SSOT。
 * 明示的な edit mode は存在せず、編集可能な content が表示されたら自動でセッションを張る
 * (常時編集。Edit ボタンは無い)。
 */
import { computed, onUnmounted, watch } from "vue";
import { useCommandRegistry } from "../../shared/command";
import { useChangesSummaryStore } from "../changes";
import { usePrDiffToggleStore } from "../git-graph";
import { useWorktreeStore } from "../worktree";
import type { PreviewContent } from "./usePreviewContent";
import { usePreviewEditStore } from "./usePreviewEditStore";

export function usePreviewEdit(content: PreviewContent) {
  const worktreeStore = useWorktreeStore();
  const prDiffToggle = usePrDiffToggleStore();
  const summaryStore = useChangesSummaryStore();
  const editStore = usePreviewEditStore();

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

  /**
   * Current タブでコード編集可能な状態か。template の CodePreview 描画条件をベースにしつつ、
   * "current" モードだけに絞ったホワイトリストなので、template がそのまま描画する "original"
   * (履歴表示、読み取り専用) はここでは false になる — 単純な描画条件のミラーではない。
   */
  const isCodePreviewActive = computed(() => {
    if (isContentUnavailable.value) return false;
    // "diff" だけでなく "original" (履歴表示) も除外する。ホワイトリストにすることで、
    // 将来 PreviewMode が増えても「編集可能なのは current だけ」の意図を構造的に保つ。
    if (activeMode.value !== "current") return false;
    if (imageSource.value !== undefined) return false;
    if (displayIsBinary.value) return false;
    if (fileType.value === "markdown" && previewEnabled.value) return false;
    if (fileType.value === "html" && previewEnabled.value) return false;
    return displayContent.value !== undefined;
  });

  /** template の DiffPreview 描画条件をミラーした判定。isEditable の Diff タブ許可に使う。
   * diff はテキスト面 (currentText / originalText) でしか成立しない (バイナリは undefined)。 */
  const isDiffPreviewActive = computed(() => {
    if (isContentUnavailable.value) return false;
    return (
      activeMode.value === "diff" &&
      originalText.value !== undefined &&
      currentText.value !== undefined
    );
  });

  /**
   * 編集可能か。対象は worktree 相対パスの実ファイル (`fsWriteFile`) と worktree 外の
   * 絶対パスの実ファイル (`fsWriteFileAbsolute`。設定 JSON 等)。commit / PR diff モードは
   * git オブジェクトから取得した履歴表示なので編集対象にしないが、この gate は
   * worktreeRelative にのみ適用する: absolute は git 文脈を持たず常に fs 実体の表示
   * (`usePreviewContent` の absolute 分岐が commit 選択と無関係に fs 読みで確定する) のため、
   * git-graph の commit 選択が同居していても編集を塞がない。編集面は Current タブ
   * (CodePreview の editable) と Diff タブ (DiffPreview の Monaco diff editor、modified 側)。
   * Original タブは履歴表示のため対象外。
   */
  const isEditable = computed(() => {
    const sel = worktreeStore.selection;
    if (sel === undefined) return false;
    if (sel.kind === "worktreeRelative") {
      if (isCommitMode.value) return false;
      if (prDiffToggle.isOn) return false;
    }
    return isCodePreviewActive.value || isDiffPreviewActive.value;
  });

  /** Save / Discard ボタンの活性判定。編集内容の SSOT は editStore.draftContent。 */
  const isDirty = computed(() => editStore.isDirty);

  /**
   * 編集セッションの自動同期。編集可能な content が表示された時点でセッションを張る。
   * `beginSession` は「同一 target + 保存済み内容一致」なら no-op で dirty draft を保持する
   * ため、タブ切替 (current → original → current) やこの watch の再発火で未保存の編集は
   * 失われない。表示対象そのものの切替は usePreviewContent の main watch が `endSession` で
   * 先に畳む。
   */
  watch(
    [isEditable, currentText] as const,
    ([editable, text]) => {
      if (!editable || text === undefined) return;
      const sel = worktreeStore.selection;
      if (sel?.kind === "absolute") {
        editStore.beginSession({ kind: "absolute", absPath: sel.absPath }, text);
        return;
      }
      const dir = worktreeStore.dir;
      const relPath = worktreeStore.selectedRelPath;
      if (dir === undefined || relPath === undefined) return;
      editStore.beginSession({ kind: "worktreeRelative", dir, relPath }, text);
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
   * PreviewPane は popover 要素として常時 mount される前提のため、onUnmounted は実質アプリ終了時のみ。
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
  onUnmounted(disposeSaveCommand);

  return {
    isEditable,
    isDirty,
    discardEdit,
    saveEdit,
  };
}
