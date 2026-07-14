/**
 * preview popover から固定化 (pin) されたファイルプレビュー群の module singleton。
 *
 * pinned window はファイル選択 / worktree 切り替えと独立して存在し続ける。内容は pin 時点の
 * スナップショット (raw source) で、選択状態には乗らずライブ更新もしない
 * (usePinnedLog と同じ独立性の設計)。`usePreviewContent` は global selection
 * (worktree / git-graph / PR diff) に結合した状態機械のため、pin 側をライブにするには
 * 選択状態の多重化が要る。git / working tree への追従・編集・blame 等の文脈機能が必要に
 * なったら、pin 元の選択を焼き込んだ `source` から本体 preview として開き直す
 * (PinnedPreviewWindow の open ボタン = worktree 切替 + filer reveal + preview 表示)。
 *
 * ウィンドウ状態 (位置 / 初期本文サイズ / z / drag handoff) は floating-window の
 * `createFloatingWindows` に委譲する。
 */
import { createFloatingWindows, type FloatingWindowState } from "../floating-window";
import type { PreviewMode } from "./previewMode";

/**
 * pin されたファイルの raw source snapshot。表示形は保存せず、window 側が
 * doc + view 状態 (mode / preview / wrap) から都度導出する (PinnedPreviewWindow の
 * view computed。fileType も filePath から再導出する)。current / original の 2 rev の
 * テキストを持ち、diff 表示もこの 2 つから導出する。バイナリ (画像) はテキストを
 * 持たず、表示 URL は source + mode から都度組み立てる (バイナリの bytes は JSON
 * ワイヤに乗らないため renderer は URL 参照しか持てない。docs/architecture.md の
 * gozd-file:// の存在理由と同じ)。
 */
export interface PinnedPreviewDoc {
  filePath: string;
  /** current 側テキスト。バイナリは undefined。 */
  current: string | undefined;
  /** original (比較元) 側テキスト。比較元が無い / バイナリは undefined。 */
  original: string | undefined;
}

/**
 * 「本体 preview として開き直す」ボタンの対象。pin 元の選択を焼き込む。
 * worktree は setOpen(dir) + forceSelect(relPath) で「wt 切替 + filer reveal + preview 表示」、
 * absolute は forceSelect(absPath) のみ (wt 文脈も filer reveal も持たない)。
 */
export type PinnedPreviewSource =
  | { kind: "worktree"; dir: string; relPath: string }
  | { kind: "absolute"; absPath: string };

interface PinnedPreviewData {
  /**
   * ヘッダ上段: repo 名 (PinnedLogWindow と同構成)。pinned window は worktree 切替を跨いで
   * 生存するため、pin 時点の出自を焼き込む。未解決 / worktree 外の絶対パスは空文字で
   * 上段ごと省く。
   */
  repoName: string;
  /** RepoIcon 用の GitHub owner。空文字は identicon フォールバック。 */
  repoOwner: string;
  /** ヘッダ上段の worktree 識別 (branch 名)。detached HEAD 等の未解決は空文字で省く。 */
  branch: string;
  /** ヘッダ下段の表示 + file icon 解決に使うファイル名。 */
  fileName: string;
  /** ヘッダ title 属性用のフルパス表記。 */
  displayPath: string;
  /**
   * pin 時点で利用可能だったモードタブ一覧 (本体 availableModes の snapshot)。
   * git change 種別に依存する判定を window に持ち込まないため、結果だけを焼き込む。
   */
  modes: PreviewMode[];
  /** pin 時点のモード。window 側モードタブの初期値 (以後は window ローカル state)。 */
  activeMode: PreviewMode;
  /** Original タブの hash 表記 (本体 PreviewToolbar と同じ)。undefined は表記なし。 */
  originalHashLabel: string | undefined;
  /** pin 時点の折り返し設定。window 側 Wrap トグルの初期値 (以後は window ローカル state)。 */
  wordWrap: boolean;
  /** pin 時点の Preview トグル状態。window 側トグルの初期値 (以後は window ローカル state)。 */
  previewEnabled: boolean;
  doc: PinnedPreviewDoc;
  source: PinnedPreviewSource;
}

export type PinnedPreview = PinnedPreviewData & FloatingWindowState;

const store = createFloatingWindows<PinnedPreviewData>();

export function usePinnedPreview() {
  const { windows, pin, takeHandoff, close, move, bringToFront } = store;
  return { previews: windows, pin, takeHandoff, close, move, bringToFront };
}
