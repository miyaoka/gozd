/**
 * Preview 編集可否とセッション同期の判定ロジック (純粋関数)。
 *
 * `usePreviewEdit` (Vue への配線層: watch / computed / コマンド登録) から判定だけを
 * 切り出したもの。store や ref に依存せず snapshot 値のみで判定するため、bun test から
 * DOM / Vue インスタンス無しで直接検証できる (`formatCause.ts` と同じ切り方)。
 */
import type { FileType } from "./previewFileType";
import type { PreviewMode } from "./previewMode";
import type { EditTarget } from "./usePreviewEditStore";

/** 編集可否判定に使う content 取得層のスナップショット */
export interface PreviewContentSnapshot {
  isContentUnavailable: boolean;
  activeMode: PreviewMode;
  hasImage: boolean;
  displayIsBinary: boolean;
  fileType: FileType;
  previewEnabled: boolean;
  hasDisplayContent: boolean;
  hasOriginalText: boolean;
  hasCurrentText: boolean;
}

/**
 * Current タブでコード編集可能な状態か。template の CodePreview 描画条件をベースにしつつ、
 * "current" モードだけに絞ったホワイトリストなので、template がそのまま描画する "original"
 * (履歴表示、読み取り専用) はここでは false になる — 単純な描画条件のミラーではない。
 */
export function isCodePreviewActive(s: PreviewContentSnapshot): boolean {
  if (s.isContentUnavailable) return false;
  // "diff" だけでなく "original" (履歴表示) も除外する。ホワイトリストにすることで、
  // 将来 PreviewMode が増えても「編集可能なのは current だけ」の意図を構造的に保つ。
  if (s.activeMode !== "current") return false;
  if (s.hasImage) return false;
  if (s.displayIsBinary) return false;
  if (s.fileType === "markdown" && s.previewEnabled) return false;
  if (s.fileType === "html" && s.previewEnabled) return false;
  return s.hasDisplayContent;
}

/** template の DiffPreview 描画条件をミラーした判定。isEditable の Diff タブ許可に使う。
 * diff はテキスト面 (currentText / originalText) でしか成立しない (バイナリは undefined)。 */
export function isDiffPreviewActive(s: PreviewContentSnapshot): boolean {
  if (s.isContentUnavailable) return false;
  return s.activeMode === "diff" && s.hasOriginalText && s.hasCurrentText;
}

/** 編集可否のうち selection / git 文脈による gate */
export interface EditableGate {
  selectionKind: "worktreeRelative" | "absolute" | undefined;
  isCommitMode: boolean;
  prDiffOn: boolean;
}

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
export function isEditablePreview(gate: EditableGate, s: PreviewContentSnapshot): boolean {
  if (gate.selectionKind === undefined) return false;
  if (gate.selectionKind === "worktreeRelative") {
    if (gate.isCommitMode) return false;
    if (gate.prDiffOn) return false;
  }
  return isCodePreviewActive(s) || isDiffPreviewActive(s);
}

/** セッション同期判定の入力。可視状態 + 編集可否 + 対象解決の材料 */
export interface SessionSyncInput {
  open: boolean;
  summaryEnabled: boolean;
  editable: boolean;
  text: string | undefined;
  selection: { kind: "worktreeRelative" } | { kind: "absolute"; absPath: string } | undefined;
  dir: string | undefined;
  relPath: string | undefined;
}

/**
 * 不変条件「セッションが存在 ⇔ popover 表示中 && summary 外 && 編集可能な content 表示」の
 * 「張る」側の判定。張るべき `EditTarget` を返し、条件を満たさない / 対象を解決できない
 * 場合は undefined (no-op)。
 */
export function resolveSessionTarget(input: SessionSyncInput): EditTarget | undefined {
  if (!input.open || input.summaryEnabled || !input.editable || input.text === undefined) {
    return undefined;
  }
  if (input.selection?.kind === "absolute") {
    return { kind: "absolute", absPath: input.selection.absPath };
  }
  if (input.dir === undefined || input.relPath === undefined) return undefined;
  return { kind: "worktreeRelative", dir: input.dir, relPath: input.relPath };
}
