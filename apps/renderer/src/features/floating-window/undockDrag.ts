/**
 * undock と同時にドラッグを開始する引き継ぎ情報。in-app シェル (FloatingWindow) と
 * OS ウィンドウシェル (ChildWindow) の両方が同じ契約で扱うため、どちらの状態管理 factory にも
 * 属さない独立モジュールに置く。
 */

/**
 * undock 元ヘッダのドラッグで undock する経路では、掴んでいた要素が undock と同時に消える
 * (unmount / hide) ため pointer capture を持ち越せない。undock() がこれを預かり、mount された
 * ウィンドウが takeHandoff() で 1 回だけ消費して同じ pointerId のドラッグとして継続する。
 */
export interface UndockDragHandoff {
  pointerId: number;
  /** pointer からウィンドウ原点 (コンテンツ rect 左上) へのオフセット。 */
  offsetX: number;
  offsetY: number;
}
