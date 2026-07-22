/**
 * preview popover から切り離し (undock) されたファイルプレビュー群の module singleton。
 *
 * undocked window はファイル選択 / worktree 切り替えと独立して存在し続ける (useUndockedLog と
 * 同じ独立性の設計)。global selection には乗らないが、current 側の中身は window ごとに
 * source の実ファイルへ追従し、編集もできる (per-window の draft / save。実装は
 * UndockedPreviewWindow の doc 参照)。`usePreviewContent` (global selection に結合した
 * 状態機械) を多重化するのではなく、window ローカルの軽量な fetch / edit を持つ。
 * original (比較元 rev) 側は undock 時点に固定で、git 文脈 (rev 追従・blame) が必要になったら
 * undock 元の選択を焼き込んだ `source` から本体 preview として開き直す
 * (UndockedPreviewWindow の open ボタン = worktree 切替 + filer reveal + preview 表示)。
 *
 * ウィンドウの実体は別 OS ウィンドウ (floating-window の ChildWindow)。ここが持つのは
 * 生成パラメータ (初期スクリーン座標 / サイズ) と snapshot payload だけで、生成後の
 * 位置 / サイズ / 前面順は OS が SSOT。永続化はしない (undocked window は揮発的)。
 */
import type { WireBytes } from "@gozd/rpc";
import { ref, type Ref } from "vue";
import type { UndockDragHandoff } from "../floating-window";
import type { PreviewMode } from "./previewMode";

/**
 * undock されたファイルの raw source。表示形は保存せず、window 側が
 * doc + view 状態 (mode / preview / wrap) から都度導出する (UndockedPreviewWindow の
 * view computed。fileType も filePath から再導出する)。current / original の 2 rev の
 * 中身を持ち、diff / 画像表示もこの 2 つから導出する。テキストは string、バイナリは
 * bytes (FileReadResult と同じ union 契約)。
 */
export interface UndockedPreviewDoc {
  filePath: string;
  /** current 側の undock 時点の中身 (window 側 live 追従の初期値)。テキストは string、
   * バイナリは bytes。無ければ undefined。未保存編集は含まない (draft は initialDraft で
   * 別途運ぶ — current は dirty 判定の基準になる disk / rev 内容)。 */
  current: string | WireBytes | undefined;
  /** original (比較元) 側の中身。undock 後も不変。比較元が無ければ undefined。 */
  original: string | WireBytes | undefined;
}

/**
 * 「本体 preview として開き直す」ボタンの対象。undock 元の選択を焼き込む。
 * worktree は setOpen(dir) + forceSelect(relPath) で「wt 切替 + filer reveal + preview 表示」、
 * absolute は forceSelect(absPath) のみ (wt 文脈も filer reveal も持たない)。
 */
export type UndockedPreviewSource =
  | { kind: "worktree"; dir: string; relPath: string }
  | { kind: "absolute"; absPath: string };

interface UndockedPreviewData {
  /**
   * ヘッダ上段: repo 名 (UndockedLogWindow と同構成)。undocked window は worktree 切替を跨いで
   * 生存するため、undock 時点の出自を焼き込む。未解決 / worktree 外の絶対パスは空文字で
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
   * undock 時点で利用可能だったモードタブ一覧 (本体 availableModes の snapshot)。
   * git change 種別に依存する判定を window に持ち込まないため、結果だけを焼き込む。
   */
  modes: PreviewMode[];
  /** undock 時点のモード。window 側モードタブの初期値 (以後は window ローカル state)。 */
  activeMode: PreviewMode;
  /** Original タブの hash 表記 (本体 PreviewToolbar と同じ)。undefined は表記なし。 */
  originalHashLabel: string | undefined;
  /** undock 時点の折り返し設定。window 側 Wrap トグルの初期値 (以後は window ローカル state)。 */
  wordWrap: boolean;
  /** undock 時点の Preview トグル状態。window 側トグルの初期値 (以後は window ローカル state)。 */
  previewEnabled: boolean;
  /** current 側が working tree の実ファイル内容か。false (過去 rev の歴史表示を undock した)
   * なら window は live 追従も編集もせず undock 時 snapshot に固定する — 過去の内容で
   * 実ファイルを上書き保存する事故を構造的に防ぐ。 */
  currentIsWorkingTree: boolean;
  /** undock 時点の本体の未保存編集 (window 側 draft の初期値)。undock は draft の「移動」で、
   * 本体セッションは undock 時に畳まれるため、未保存編集の所有者はウィンドウに一意化される。
   * クリーンな undock / 編集不可 (currentIsWorkingTree=false) は undefined。 */
  initialDraft: string | undefined;
  doc: UndockedPreviewDoc;
  source: UndockedPreviewSource;
}

/** OS child window の生成パラメータ。undock 元 pane の実測 rect をスクリーン座標へ
 * 換算した値で、pane がその場で OS ウィンドウ化したような視覚的連続性を出す。 */
interface UndockedPreviewWindowInit {
  screenX: number;
  screenY: number;
  width: number;
  height: number;
}

export type UndockedPreview = UndockedPreviewData & UndockedPreviewWindowInit & { id: number };

// Ref cast は createFloatingWindows と同じ理由 (payload union の UnwrapRef を避ける)
const windows = ref([]) as Ref<UndockedPreview[]>;
let nextId = 0;

// undock() → mount → takeHandoff() が同期フラッシュ内で完結するため reactive にしない
// (createFloatingWindows と同じ one-shot 引き継ぎ。OS ウィンドウ版は ChildWindow が
// moveTo 追従に変換する)。
let pendingHandoff: ({ id: number } & UndockDragHandoff) | undefined;

function undock(
  input: UndockedPreviewData & UndockedPreviewWindowInit,
  handoff?: UndockDragHandoff,
) {
  const id = nextId++;
  windows.value.push({ ...input, id });
  if (handoff !== undefined) pendingHandoff = { id, ...handoff };
}

/** id 宛の drag handoff を 1 回だけ消費する。無ければ undefined。 */
function takeHandoff(id: number): UndockDragHandoff | undefined {
  if (pendingHandoff === undefined || pendingHandoff.id !== id) return undefined;
  const { pointerId, offsetX, offsetY } = pendingHandoff;
  pendingHandoff = undefined;
  return { pointerId, offsetX, offsetY };
}

function close(id: number) {
  windows.value = windows.value.filter((w) => w.id !== id);
}

export function useUndockedPreview() {
  return { previews: windows, undock, takeHandoff, close };
}
