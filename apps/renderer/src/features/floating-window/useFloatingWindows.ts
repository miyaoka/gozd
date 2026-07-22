/**
 * undock されたフローティングウィンドウ群の状態管理 factory。
 *
 * undocked window は undock 元 (popover / pane) の表示状態と独立して存在し続けるため、
 * consumer feature (session-log / preview) が module スコープで `createFloatingWindows<T>()`
 * を 1 回だけ実行し、payload T を載せた singleton のウィンドウ列を得る。
 *
 * 位置は undock 元 (popover の box) の実測 rect、サイズは undock 元の本文 (スクロール面) の
 * 実測を初期値として受け取る。popover がその場でフローティング化したように見せる視覚的
 * 連続性のため。サイズを総高さでなく本文で受け渡すのは、undock 元とウィンドウでヘッダの
 * 高さが違うため。総高さを引き継ぐと増えたヘッダ分だけ本文が食われて切れる。ウィンドウは
 * mount 時に自分のヘッダ実測高を足して総高さを決める。以後、位置 (x / y) はドラッグと
 * 左/上辺リサイズで更新されるが、サイズは store 上では初期値のまま不変で、リサイズの
 * SSOT はリサイズハンドラが書く DOM の inline style に移る (FloatingWindow の doc 参照)。
 *
 * z カウンタは全 factory instance で共有する。種類の異なるウィンドウ (log / preview) も
 * 同じ plain fixed のスタッキング文脈に並ぶため、カウンタを instance ごとに分けると
 * 種類を跨いだ bring-to-front が効かなくなる。
 */
import { computed, ref, shallowReactive, type Ref } from "vue";

export interface FloatingWindowState {
  id: number;
  x: number;
  y: number;
  /**
   * 初期の本文 (スクロール面) サイズ (undock 元の本文実測。総サイズでない理由は
   * モジュール docstring 参照)。mount 後はリサイズハンドラが inline style を上書きする。
   */
  bodyWidth: number;
  bodyHeight: number;
  z: number;
  /**
   * 外部 (cmd+w の closeFrontFloatingWindow 等) からの close 要求 epoch。増加を
   * FloatingWindow シェルが close emit へ変換し、consumer の close 経路 (未保存確認
   * ガード込み) に合流させる。store が直接 close しないのは、close してよいかの判断
   * (dirty 確認等) が consumer の知識のため。
   */
  closeRequested: number;
}

/**
 * undock と同時にドラッグを開始する引き継ぎ情報。undock 元ヘッダのドラッグで undock する経路では、
 * 掴んでいた要素が undock と同時に消える (unmount / hide) ため pointer capture を持ち越せない。
 * undock() がこれを預かり、mount されたウィンドウが takeHandoff() で 1 回だけ消費して
 * 同じ pointerId のドラッグとして継続する。
 */
export interface UndockDragHandoff {
  pointerId: number;
  /** pointer からウィンドウ原点 (rect 左上) へのオフセット。 */
  offsetX: number;
  offsetY: number;
}

// bring-to-front の z 初期値。plain fixed 要素どうしの相対順にだけ効き、dialog / popover の
// top layer は z-index に関係なく常に手前 (ArcadeLayer の doc 参照)。
const Z_BASE = 30;

// 全 factory instance で共有 (モジュール docstring 参照)。
let zTop = Z_BASE;

/**
 * 全 factory instance の registry。種類の異なるウィンドウ (log / preview) を跨いで
 * 「最前面の 1 枚」を特定するために module で持つ。Ref の invariance を避けるため
 * windows は getter で覆って FloatingWindowState[] へ covariant に読み出す。
 * shallowReactive なのは、consumer module の HMR 再実行で instance が後から増えても
 * hasFloatingWindow の computed が追跡し直せるようにするため。
 */
const instances = shallowReactive<
  { getWindows: () => readonly FloatingWindowState[]; requestClose: (id: number) => void }[]
>([]);

/** undock されたウィンドウが 1 枚でも存在するか (floatingWindowVisible context key の source)。 */
export const hasFloatingWindow = computed(() =>
  instances.some((instance) => instance.getWindows().length > 0),
);

/**
 * 全種のウィンドウのうち最前面 (z 最大) の 1 枚に close を要求する。1 枚も無ければ false。
 * 即 close ではなく closeRequested 経由で consumer の close 経路 (未保存確認ガード込み) に
 * 合流させるため、要求後もウィンドウが (確認 Cancel で) 残ることがある。
 */
export function closeFrontFloatingWindow(): boolean {
  let front: { requestClose: (id: number) => void; id: number; z: number } | undefined;
  for (const instance of instances) {
    for (const win of instance.getWindows()) {
      if (front === undefined || win.z > front.z) {
        front = { requestClose: instance.requestClose, id: win.id, z: win.z };
      }
    }
  }
  if (front === undefined) return false;
  front.requestClose(front.id);
  return true;
}

export function createFloatingWindows<T>() {
  const windows = ref([]) as Ref<(T & FloatingWindowState)[]>;
  let nextId = 0;
  // undock() → mount → takeHandoff() が同期フラッシュ内で完結するため reactive にしない。
  let pendingHandoff: ({ id: number } & UndockDragHandoff) | undefined;

  function undock(
    input: T & Omit<FloatingWindowState, "id" | "z" | "closeRequested">,
    handoff?: UndockDragHandoff,
  ) {
    const id = nextId++;
    windows.value.push({ ...input, id, z: ++zTop, closeRequested: 0 });
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

  /** 外部からの close 要求 (FloatingWindowState.closeRequested の docstring 参照) */
  function requestClose(id: number) {
    const win = windows.value.find((w) => w.id === id);
    if (win === undefined) return;
    win.closeRequested++;
  }

  function move(id: number, x: number, y: number) {
    const win = windows.value.find((w) => w.id === id);
    if (win === undefined) return;
    win.x = x;
    win.y = y;
  }

  function bringToFront(id: number) {
    const win = windows.value.find((w) => w.id === id);
    if (win === undefined) return;
    // zTop は全種共有のため、他種のウィンドウが後から undock されていれば z !== zTop になり
    // 正しく再前面化される
    if (win.z === zTop) return;
    win.z = ++zTop;
  }

  instances.push({ getWindows: () => windows.value, requestClose });

  return { windows, undock, takeHandoff, close, move, bringToFront };
}
