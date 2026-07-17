/**
 * preview popover から固定化 (pin) されたファイルプレビュー群の module singleton。
 *
 * pinned window はファイル選択 / worktree 切り替えと独立して存在し続ける (usePinnedLog と
 * 同じ独立性の設計)。global selection には乗らないが、current 側の中身は window ごとに
 * source の実ファイルへ追従し、編集もできる (per-window の draft / save。実装は
 * PinnedPreviewWindow の doc 参照)。`usePreviewContent` (global selection に結合した
 * 状態機械) を多重化するのではなく、window ローカルの軽量な fetch / edit を持つ。
 * original (比較元 rev) 側は pin 時点に固定で、git 文脈 (rev 追従・blame) が必要になったら
 * pin 元の選択を焼き込んだ `source` から本体 preview として開き直す
 * (PinnedPreviewWindow の open ボタン = worktree 切替 + filer reveal + preview 表示)。
 *
 * ウィンドウ状態 (位置 / 初期本文サイズ / z / drag handoff) は floating-window の
 * `createFloatingWindows` に委譲する。
 */
import type { WireBytes } from "@gozd/rpc";
import { createFloatingWindows, type FloatingWindowState } from "../floating-window";
import type { PreviewMode } from "./previewMode";

/**
 * pin されたファイルの raw source。表示形は保存せず、window 側が
 * doc + view 状態 (mode / preview / wrap) から都度導出する (PinnedPreviewWindow の
 * view computed。fileType も filePath から再導出する)。current / original の 2 rev の
 * 中身を持ち、diff / 画像表示もこの 2 つから導出する。テキストは string、バイナリは
 * bytes (FileReadResult と同じ union 契約)。
 */
export interface PinnedPreviewDoc {
  filePath: string;
  /** current 側の pin 時点の中身 (window 側 live 追従の初期値)。テキストは string
   * (編集 draft 込み)、バイナリは bytes。無ければ undefined。 */
  current: string | WireBytes | undefined;
  /** original (比較元) 側の中身。pin 後も不変。比較元が無ければ undefined。 */
  original: string | WireBytes | undefined;
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
  /** current 側が working tree の実ファイル内容か。false (過去 rev の歴史表示を pin した)
   * なら window は live 追従も編集もせず pin 時 snapshot に固定する — 過去の内容で
   * 実ファイルを上書き保存する事故を構造的に防ぐ。 */
  currentIsWorkingTree: boolean;
  doc: PinnedPreviewDoc;
  source: PinnedPreviewSource;
}

export type PinnedPreview = PinnedPreviewData & FloatingWindowState;

const store = createFloatingWindows<PinnedPreviewData>();

export function usePinnedPreview() {
  const { windows, pin, takeHandoff, close, move, bringToFront } = store;
  return { previews: windows, pin, takeHandoff, close, move, bringToFront };
}
