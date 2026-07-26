/**
 * undock されたウィンドウ群の状態管理 factory。
 *
 * undocked window は undock 元 (popover / pane) の表示状態と独立して存在し続けるため、
 * consumer feature (session-log / preview) が module スコープで `createFloatingWindows<T>(label)` を
 * 1 回だけ実行し、payload T を載せた singleton のウィンドウ列を得る。id は instance ごとの
 * 0 始まりカウンタなので、観察ログで instance を区別するために label を要求する。
 *
 * 位置は undock 元 (popover / pane の box) の実測 rect、サイズは undock 元の**中身**
 * (シェルヘッダを除いた領域。preview ならモードタブ + 本文、log なら本文) の実測を初期値として
 * 受け取る。undock 元がその場でパネル化したように見せる視覚的連続性のため。総サイズでなく
 * 中身で受け渡すのは、undock 元とパネルでヘッダの高さが違うため — 総サイズを引き継ぐと増えた
 * ヘッダ分だけ中身が食われて切れる。パネルは mount 時に自分のヘッダ実測高を足して総サイズを
 * 決めるので、渡す値に undock 元のヘッダを含めてはいけない (含めるとその分中身が縮む)。
 * 以後、位置 (x / y) はドラッグと左/上辺リサイズで更新されるが、サイズは store 上では初期値の
 * まま不変で、リサイズの SSOT はリサイズハンドラが書く DOM の inline style に移る
 * (FloatingWindow の doc 参照)。
 *
 * 前面化の順序 (frontOrder) は全 factory instance で共有するカウンタで採番する。種類の異なる
 * ウィンドウも同じサーフェス列に並ぶため、カウンタを instance ごとに分けると種類を跨いだ
 * bring-to-front が効かなくなる。
 *
 * undock 直後は in-app パネルで、`promote()` で別 OS ウィンドウへ昇格する。昇格後も entry は
 * 同じ id のまま残り (payload の所有者は 1 つ)、`child` の有無が「今どちらの presentation で
 * 描かれているか」の SSOT になる (切り替えは UndockedWindow が担う)。
 */
import { computed, ref, shallowReactive, type Ref } from "vue";
import type { ChildWindowInit } from "./childWindowInit";

/**
 * undock と同時にドラッグを開始する引き継ぎ情報。undock 元ヘッダのドラッグで undock する
 * 経路では、掴んでいた要素が undock と同時に消える (unmount / hide) ため pointer capture を
 * 持ち越せない。`undock()` がこれを預かり、mount されたパネルが `takeHandoff()` で 1 回だけ
 * 消費して同じ pointerId のドラッグとして継続する。
 */
export interface UndockDragHandoff {
  pointerId: number;
  /** pointer からパネル原点 (rect 左上) へのオフセット。 */
  offsetX: number;
  offsetY: number;
}

export interface FloatingWindowState {
  id: number;
  x: number;
  y: number;
  /**
   * 初期の中身サイズ (undock 元のシェルヘッダを除いた領域の実測。総サイズでない理由は
   * モジュール docstring 参照)。mount 後はリサイズハンドラが inline style を上書きする。
   */
  contentWidth: number;
  contentHeight: number;
  /**
   * 最後に前面化された順序。大きいほど手前 (cmd+w の closeFront が最前面の 1 枚を選ぶ判定に
   * 使う)。実際の描画順は DOM の top layer が持ち、本フィールドはそれと同じ `activate` イベント
   * から書かれる控え (`shared/surface` は最前面 1 枚しか覚えないため、パネル群の中の順序を
   * DOM に問い合わせる手段がない)。
   */
  frontOrder: number;
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

// 全 factory instance で共有する前面化順序のカウンタ (モジュール docstring 参照)。
let frontOrderTop = 0;

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
 * 全種の in-app パネルのうち最前面 (frontOrder 最大) の 1 枚に close を要求する。1 枚も無ければ false。
 * 即 close ではなく closeRequestEpoch 経由で consumer の close 経路 (未保存確認ガード込み) に
 * 合流させるため、要求後もパネルが (確認 Cancel で) 残ることがある。
 */
export function closeFrontFloatingWindow(): boolean {
  let front: { requestClose: (id: number) => void; id: number; frontOrder: number } | undefined;
  for (const instance of instances) {
    for (const win of inAppWindows(instance)) {
      if (front === undefined || win.frontOrder > front.frontOrder) {
        front = { requestClose: instance.requestClose, id: win.id, frontOrder: win.frontOrder };
      }
    }
  }
  if (front === undefined) return false;
  front.requestClose(front.id);
  return true;
}

export function createFloatingWindows<T>(label: string) {
  const windows = ref([]) as Ref<(T & FloatingWindowState)[]>;
  let nextId = 0;
  // undock() → mount → takeHandoff() が同期フラッシュ内で完結するため reactive にしない。
  let pendingHandoff: ({ id: number } & UndockDragHandoff) | undefined;

  function undock(
    input: T & Omit<FloatingWindowState, "id" | "frontOrder" | "closeRequestEpoch" | "child">,
    handoff?: UndockDragHandoff,
  ) {
    const id = nextId++;
    windows.value.push({ ...input, id, frontOrder: ++frontOrderTop, closeRequestEpoch: 0 });
    if (handoff !== undefined) pendingHandoff = { id, ...handoff };
  }

  /** id 宛の drag handoff を 1 回だけ消費する。無ければ undefined。 */
  function takeHandoff(id: number): UndockDragHandoff | undefined {
    if (pendingHandoff === undefined || pendingHandoff.id !== id) return undefined;
    const { pointerId, offsetX, offsetY } = pendingHandoff;
    pendingHandoff = undefined;
    return { pointerId, offsetX, offsetY };
  }

  /**
   * id 宛の entry を引く。
   *
   * entry とパネルは同じライフサイクルで消える (entry を消すと v-for が component を unmount し、
   * window listener も effect scope 破棄で外れる) ため、id 不在に到達するのは呼び出し元が既に
   * 消えた id を握っている状態。同期経路 (pointer / click ハンドラ) しか持たない mutator では
   * それは実装の不整合を意味する。await を跨ぐ close だけは競合経路を持つ (close の doc 参照)。
   *
   * id 解決を 1 箇所に集約するのは、関数ごとに早期 return を書くと後から増えた mutator で
   * ログを書き忘れた経路が生まれるため。
   */
  function findWindow(id: number, op: string) {
    const win = windows.value.find((w) => w.id === id);
    if (win === undefined) {
      console.error(`[useFloatingWindows:${label}] ${op}: window not found id=${id}`);
    }
    return win;
  }

  /**
   * entry を消す。id 不在を idempotent 成功として黙認しない — 他の mutator と違い close は
   * 呼び出し元が id を取ってから await を跨ぐ経路を持つ (preview の dirty ガードが確認ダイアログと
   * 保存 RPC の往復を挟む)。その待ち時間に同じ entry を消せるのは opener の pagehide
   * (Vite フルリロード / アプリ終了) が child window を道連れに閉じる teardown 経路
   * (ChildWindow の pagehide → closed → close) だけで、通常操作の二重 close は確認ダイアログの
   * 先勝ちと blockClose の veto で成立しない。
   */
  function close(id: number) {
    if (findWindow(id, "close") === undefined) return;
    windows.value = windows.value.filter((w) => w.id !== id);
  }

  /** 外部からの close 要求 (FloatingWindowState.closeRequestEpoch の docstring 参照) */
  function requestClose(id: number) {
    const win = findWindow(id, "requestClose");
    if (win === undefined) return;
    win.closeRequestEpoch++;
  }

  function move(id: number, x: number, y: number) {
    const win = findWindow(id, "move");
    if (win === undefined) return;
    win.x = x;
    win.y = y;
  }

  function bringToFront(id: number) {
    const win = findWindow(id, "bringToFront");
    if (win === undefined) return;
    // frontOrderTop は全種共有のため、他種のウィンドウが後から undock されていれば
    // frontOrder !== frontOrderTop になり正しく再前面化される
    if (win.frontOrder === frontOrderTop) return;
    win.frontOrder = ++frontOrderTop;
  }

  /**
   * in-app パネルを別 OS ウィンドウへ昇格させる (シェルの promote ボタン)。ユーザー操作としては
   * 一方向で、OS ウィンドウから in-app パネルへ戻す経路は持たない。
   */
  function promote(id: number, child: ChildWindowInit) {
    const win = findWindow(id, "promote");
    if (win === undefined) return;
    win.child = child;
  }

  /**
   * 昇格の取り消し (in-app パネルへ引き返す)。OS ウィンドウの生成失敗だけが呼ぶ経路で、
   * entry を消す代わりにパネルへ戻すことで payload (preview なら移動済みの未保存 draft) を
   * 失わせない。引き返し先のサイズは undock 時点の値 (リサイズ後の実サイズは inline style
   * にしか無く store へ書き戻していないため、昇格前にリサイズしていたぶんは巻き戻る)。
   */
  function demote(id: number) {
    const win = findWindow(id, "demote");
    if (win === undefined) return;
    win.child = undefined;
  }

  instances.push({ getWindows: () => windows.value, requestClose });

  return { windows, undock, takeHandoff, close, move, bringToFront, promote, demote };
}
