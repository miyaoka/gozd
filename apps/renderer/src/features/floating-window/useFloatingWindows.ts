/**
 * undock されたウィンドウ群の状態管理 factory。
 *
 * undocked window は undock 元 (popover / pane) の表示状態と独立して存在し続けるため、
 * consumer feature (session-log / preview) が module スコープで `createFloatingWindows<T>()` を
 * 1 回だけ実行し、payload T を載せた singleton のウィンドウ列を得る。
 *
 * 位置は undock 元 (popover / pane の box) の実測 rect、サイズは undock 元の本文 (スクロール面)
 * の実測を初期値として受け取る。undock 元がその場でパネル化したように見せる視覚的連続性の
 * ため。サイズを総高さでなく本文で受け渡すのは、undock 元とパネルでヘッダの高さが違うため。
 * 総高さを引き継ぐと増えたヘッダ分だけ本文が食われて切れる。パネルは mount 時に自分の
 * ヘッダ実測高を足して総高さを決める。以後、位置 (x / y) はドラッグと左/上辺リサイズで
 * 更新されるが、サイズは store 上では初期値のまま不変で、リサイズの SSOT はリサイズ
 * ハンドラが書く DOM の inline style に移る (FloatingWindow の doc 参照)。
 *
 * z カウンタは全 factory instance で共有する。種類の異なるウィンドウも同じ plain fixed の
 * スタッキング文脈に並ぶため、カウンタを instance ごとに分けると種類を跨いだ
 * bring-to-front が効かなくなる。
 *
 * undock 直後は in-app パネルで、`promote()` で別 OS ウィンドウへ昇格する。昇格後も entry は
 * 同じ id のまま残り (payload の所有者は 1 つ)、`child` の有無が「今どちらの presentation で
 * 描かれているか」の SSOT になる (切り替えは UndockedWindow が担う)。
 */
import { computed, ref, shallowReactive, type Ref } from "vue";
import type { ChildWindowInit } from "./childWindowInit";
import type { UndockDragHandoff } from "./undockDrag";

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
   * 外部 (cmd+w の closeFrontFloatingWindow 等) からの close 要求 epoch。増加をシェルが
   * closeRequested emit へ変換し、consumer の close 経路 (未保存確認ガード込み) に合流させる。
   * store が直接 close しないのは、close してよいかの判断 (dirty 確認等) が consumer の
   * 知識のため。
   */
  closeRequestEpoch: number;
  /**
   * OS ウィンドウへ昇格済みなら child window の生成パラメータ (`promote()` が書く)。
   * 定義されている entry は in-app パネルとして数えない — cmd+w の
   * closeFrontFloatingWindow / floatingWindowVisible の対象は「main window 内に見えている
   * パネル」であり、昇格後のウィンドウは OS フォーカス側の `childWindow.close` が担うため。
   */
  child?: ChildWindowInit;
}

// bring-to-front の z 初期値。plain fixed 要素どうしの相対順にだけ効き、dialog / popover の
// top layer は z-index に関係なく常に手前 (ArcadeLayer の doc 参照)。
const Z_BASE = 30;

// 全 factory instance で共有 (モジュール docstring 参照)。
let zTop = Z_BASE;

/**
 * 全 factory instance の registry。種類の異なるウィンドウを跨いで
 * 「最前面の 1 枚」を特定するために module で持つ。Ref の invariance を避けるため
 * windows は getter で覆って FloatingWindowState[] へ covariant に読み出す。
 * shallowReactive なのは、consumer module の HMR 再実行で instance が後から増えても
 * hasFloatingWindow の computed が追跡し直せるようにするため。
 */
const instances = shallowReactive<
  { getWindows: () => readonly FloatingWindowState[]; requestClose: (id: number) => void }[]
>([]);

/** in-app パネルとして描かれている (= 昇格していない) window だけを列挙する。 */
function inAppWindows(instance: { getWindows: () => readonly FloatingWindowState[] }) {
  return instance.getWindows().filter((win) => win.child === undefined);
}

/** undock された in-app パネルが 1 枚でも存在するか (floatingWindowVisible context key の source)。 */
export const hasFloatingWindow = computed(() =>
  instances.some((instance) => inAppWindows(instance).length > 0),
);

/**
 * 全種の in-app パネルのうち最前面 (z 最大) の 1 枚に close を要求する。1 枚も無ければ false。
 * 即 close ではなく closeRequestEpoch 経由で consumer の close 経路 (未保存確認ガード込み) に
 * 合流させるため、要求後もパネルが (確認 Cancel で) 残ることがある。
 */
export function closeFrontFloatingWindow(): boolean {
  let front: { requestClose: (id: number) => void; id: number; z: number } | undefined;
  for (const instance of instances) {
    for (const win of inAppWindows(instance)) {
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
    input: T & Omit<FloatingWindowState, "id" | "z" | "closeRequestEpoch" | "child">,
    handoff?: UndockDragHandoff,
  ) {
    const id = nextId++;
    windows.value.push({ ...input, id, z: ++zTop, closeRequestEpoch: 0 });
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

  /** 外部からの close 要求 (FloatingWindowState.closeRequestEpoch の docstring 参照) */
  function requestClose(id: number) {
    const win = windows.value.find((w) => w.id === id);
    if (win === undefined) return;
    win.closeRequestEpoch++;
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

  /**
   * in-app パネルを別 OS ウィンドウへ昇格させる (シェルの promote ボタン)。一方向で、
   * OS ウィンドウから in-app パネルへ戻す経路は持たない。
   */
  function promote(id: number, child: ChildWindowInit) {
    const win = windows.value.find((w) => w.id === id);
    if (win === undefined) return;
    win.child = child;
  }

  instances.push({ getWindows: () => windows.value, requestClose });

  return { windows, undock, takeHandoff, close, move, bringToFront, promote };
}
