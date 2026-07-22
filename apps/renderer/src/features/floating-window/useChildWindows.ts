/**
 * undock された別 OS ウィンドウ (ChildWindow) 群の状態管理 factory。
 *
 * undocked window は undock 元 (popover / pane) の表示状態と独立して存在し続けるため、
 * consumer feature (session-log / preview) が module スコープで `createChildWindows<T>()` を
 * 1 回だけ実行し、payload T を載せた singleton のウィンドウ列を得る。
 *
 * store が持つのは生成パラメータ (初期スクリーン座標 / サイズ) と snapshot payload だけで、
 * 生成後の位置 / サイズ / 前面順は OS が SSOT。永続化はしない (undocked window は揮発的)。
 */
import { ref, type Ref } from "vue";

/**
 * OS child window の生成パラメータ。undock 元 (popover / pane) の実測 rect をスクリーン座標へ
 * 換算した値で、undock 元がその場で OS ウィンドウ化したような視覚的連続性を出す。
 * width / height はコンテンツサイズ (titlebar 分の外枠換算は ChildWindow が行う)。
 */
export interface ChildWindowInit {
  screenX: number;
  screenY: number;
  width: number;
  height: number;
}

/**
 * undock と同時にドラッグを開始する引き継ぎ情報。undock 元ヘッダのドラッグで undock する経路では、
 * 掴んでいた要素が undock と同時に消える (unmount / hide) ため pointer capture を持ち越せない。
 * undock() がこれを預かり、mount されたウィンドウが takeHandoff() で 1 回だけ消費して
 * 同じ pointerId のドラッグとして継続する (ChildWindow が moveTo 追従に変換する)。
 */
export interface UndockDragHandoff {
  pointerId: number;
  /** pointer からウィンドウ原点 (コンテンツ rect 左上) へのオフセット。 */
  offsetX: number;
  offsetY: number;
}

export function createChildWindows<T>() {
  // Ref cast は payload union の UnwrapRef を避けるため
  const windows = ref([]) as Ref<(T & ChildWindowInit & { id: number })[]>;
  let nextId = 0;
  // undock() → mount → takeHandoff() が同期フラッシュ内で完結するため reactive にしない。
  let pendingHandoff: ({ id: number } & UndockDragHandoff) | undefined;

  function undock(input: T & ChildWindowInit, handoff?: UndockDragHandoff) {
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

  return { windows, undock, takeHandoff, close };
}
