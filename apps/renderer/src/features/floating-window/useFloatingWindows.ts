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
 * 重ね順と close の宛先は本 store の関心ではない。パネルは top layer のサーフェス 1 枚として
 * `shared/surface` に登録され、前面化 (クリック) と「フォーカスがあるものを閉じる」
 * (ESC / Cmd+W) はそちらが一括で解決する。本 store が持つのは payload と位置 / 初期サイズ / 昇格状態だけ。
 *
 * undock 直後は in-app パネルで、`promote()` で別 OS ウィンドウへ昇格する。昇格後も entry は
 * 同じ id のまま残り (payload の所有者は 1 つ)、`child` の有無が「今どちらの presentation で
 * 描かれているか」の SSOT になる (切り替えは UndockedWindow が担う)。
 */
import { ref, type Ref } from "vue";
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
  /** OS ウィンドウへ昇格済みなら child window の生成パラメータ (`promote()` が書く)。 */
  child?: ChildWindowInit;
}

export function createFloatingWindows<T>(label: string) {
  const windows = ref([]) as Ref<(T & FloatingWindowState)[]>;
  let nextId = 0;
  // undock() → mount → takeHandoff() が同期フラッシュ内で完結するため reactive にしない。
  let pendingHandoff: ({ id: number } & UndockDragHandoff) | undefined;

  function undock(
    input: T & Omit<FloatingWindowState, "id" | "child">,
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

  function move(id: number, x: number, y: number) {
    const win = findWindow(id, "move");
    if (win === undefined) return;
    win.x = x;
    win.y = y;
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

  return { windows, undock, takeHandoff, close, move, promote, demote };
}
