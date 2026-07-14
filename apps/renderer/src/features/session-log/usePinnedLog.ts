/**
 * terminal preview の全文 popover から固定化 (pin) されたメッセージ群の module singleton。
 *
 * pinned window は表示中の repo / session / terminal と独立して存在し続けるため、
 * component ローカルではなく module singleton に置く (`useSessionLogViewer` と同パターン)。
 * 内容は pin 時点のスナップショット (kind + text) で、元セッションのログ参照や
 * watch ライフサイクルには乗らない。元の popover が閉じても消えない独立性が要件のため、
 * ライブ更新はしない。
 *
 * 位置は pin 元 (popover の box) の実測 rect、サイズは pin 元の本文 (スクロール面) の
 * 実測を初期値として受け取る。popover がその場でフローティング化したように見せる視覚的
 * 連続性のため。サイズを総高さでなく本文で受け渡すのは、pin 元 popover とウィンドウで
 * ヘッダの高さが違う (pin ボタン 1 行 vs repo + タイトル 2 段) ため。総高さを引き継ぐと
 * 増えたヘッダ分だけ本文が食われて切れる。ウィンドウは mount 時に自分のヘッダ実測高を
 * 足して総高さを決める。以後、位置 (x / y) はドラッグで更新されるが、サイズは初期値の
 * まま不変で、リサイズの SSOT は CSS `resize: both` が書く DOM の inline style に移る。
 */
import { ref } from "vue";

export interface PinnedLog {
  id: number;
  kind: "user" | "assistant";
  /** ヘッダ上段: repo 名 (TerminalLeafTitle と同構成)。未解決は空文字で上段ごと省く。 */
  repoName: string;
  /** RepoIcon 用の GitHub owner。空文字は identicon フォールバック。 */
  repoOwner: string;
  /** ヘッダ下段: session タイトル (+ sub 由来は subagent ラベル)。 */
  title: string;
  text: string;
  x: number;
  y: number;
  /**
   * 初期の本文 (スクロール面) サイズ (pin 元 popover の本文実測。総サイズでない理由は
   * モジュール docstring 参照)。mount 後は native resize が inline style を上書きする。
   */
  bodyWidth: number;
  bodyHeight: number;
  z: number;
}

/**
 * pin と同時にドラッグを開始する引き継ぎ情報。popover ヘッダのドラッグで pin する経路では、
 * 掴んでいた popover 要素が pin と同時に消えるため pointer capture を持ち越せない。
 * pin() がこれを預かり、mount された PinnedLogWindow が takeHandoff() で 1 回だけ消費して
 * 同じ pointerId のドラッグとして継続する。
 */
export interface PinDragHandoff {
  pointerId: number;
  /** pointer からウィンドウ原点 (rect 左上) へのオフセット。 */
  offsetX: number;
  offsetY: number;
}

// bring-to-front の z 初期値。plain fixed 要素どうしの相対順にだけ効き、dialog / popover の
// top layer は z-index に関係なく常に手前 (ArcadeLayer の doc 参照)。
const Z_BASE = 30;

const logs = ref<PinnedLog[]>([]);
let nextId = 0;
let zTop = Z_BASE;
// pin() → mount → takeHandoff() が同期フラッシュ内で完結するため reactive にしない。
let pendingHandoff: ({ id: number } & PinDragHandoff) | undefined;

export function usePinnedLog() {
  function pin(input: Omit<PinnedLog, "id" | "z">, handoff?: PinDragHandoff) {
    const id = nextId++;
    logs.value.push({ ...input, id, z: ++zTop });
    if (handoff !== undefined) pendingHandoff = { id, ...handoff };
  }

  /** id 宛の drag handoff を 1 回だけ消費する。無ければ undefined。 */
  function takeHandoff(id: number): PinDragHandoff | undefined {
    if (pendingHandoff === undefined || pendingHandoff.id !== id) return undefined;
    const { pointerId, offsetX, offsetY } = pendingHandoff;
    pendingHandoff = undefined;
    return { pointerId, offsetX, offsetY };
  }

  function close(id: number) {
    logs.value = logs.value.filter((log) => log.id !== id);
  }

  function move(id: number, x: number, y: number) {
    const log = logs.value.find((l) => l.id === id);
    if (log === undefined) return;
    log.x = x;
    log.y = y;
  }

  function bringToFront(id: number) {
    const log = logs.value.find((l) => l.id === id);
    if (log === undefined) return;
    if (log.z === zTop) return;
    log.z = ++zTop;
  }

  return { logs, pin, takeHandoff, close, move, bringToFront };
}
