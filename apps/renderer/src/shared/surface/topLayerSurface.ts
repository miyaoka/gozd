/**
 * top layer に載る「サーフェス」(preview / server list / event log / notification center の
 * 右ドックパネル、undock された各パネル) の重ね順を扱う。
 *
 * 重ね順の規則は「最後に触ったものが最前面」。ウィンドウマネージャの click-to-front と同じで、
 * 開いた / クリックしたサーフェスが手前に来る。サーフェス間に固定の優先順位は持たない。
 *
 * top layer の順序は `showPopover()` の**呼び出し順**が SSOT で、z-index では越えられない。
 * したがって前面化は「hide してから show し直す」しか手段がなく、開閉と前面化を同じ 1 箇所に
 * 集約しないと「今どれが最前面か」を誰も知らない状態になる。本モジュールが前面順を控えるのは、
 * 無意味な積み直しを弾くためと「最前面を閉じる」を解決するためで、順序そのものの SSOT は
 * あくまでブラウザ側の top layer にある。この控えが嘘にならないよう、サーフェスの開閉は必ず
 * 本モジュールを通す (素の `showPopover()` を呼ぶと控えが腐り、以後その要素への `raiseSurface`
 * が黙って no-op になり、close の宛先もずれる)。
 *
 * この hide → show は見た目のコストを持たない。スタイル再計算は次のレンダリング更新まで
 * 遅延され、2 つの呼び出しの間にジオメトリ読み取り (強制同期レイアウト) を挟まないため、
 * `display: none` の状態は一度も具現化しない。よって box が破棄されず、スクロール位置の
 * リセットも入場アニメーションの再生も起きない。一方 top layer の順序はレンダリングでは
 * なくドキュメントの状態なので、具現化を待たずに変わる。
 *
 * フォーカスの退避は持たない。`hidePopover()` はフォーカスがその要素の中にあるとき外へ落とすが、
 * 積み直しの発火源であるクリック自体が同じことをする — 非 focusable な領域を押せば、既定動作が
 * 最も近い focusable な祖先へ移し、無ければ body へ落とす。積み直しの有無でフォーカスの行き先は
 * 変わらないため、退避しても復元先は同じになる。
 *
 * ## 閉じる順序
 *
 * ESC と Cmd+W は同義で「最前面のサーフェスを閉じる」。開く順序と閉じる順序が別の規則を持つと、
 * 見えている前面と操作対象が食い違う。close の実処理 (未保存確認等) はサーフェスごとに違うため、
 * `useSurface` の登録時に受け取ったハンドラへ委譲する。
 *
 * モーダル (`<dialog>`) とメニュー (`popover="auto"`) には譲る。前者は UA の cancel が ESC を
 * 処理し、後者は UA の light-dismiss が閉じるので、こちらまで同時に閉じない。
 *
 * ## pin (常時最前面)
 *
 * トーストだけは click-to-front の列に加えず、常にサーフェスより手前へ留める。エラー通知の
 * 一次表示であり、パネルに埋もれると失敗の可視性が落ちるため。`pinSurface()` で登録すると、
 * サーフェスの show / raise のたびに pin 側を積み直して最前面を保つ。
 *
 * メニュー (`popover="auto"`) は pin しない。サーフェスの前面化はクリックで起き、そのクリックが
 * メニューの light-dismiss も同時に起こすため、覆われた状態が残らない。モーダル (`<dialog>`) も
 * pin しない。backdrop が背後のクリックを吸うのでサーフェスの前面化経路が無い (ただし popover は
 * dialog より後に top layer へ入ると modal の上に見える。SettingsModal の doc 参照)。
 */

import { computed, shallowRef } from "vue";

/**
 * 開いているサーフェスを前面順に持つ (末尾が最前面)。無駄な hide/show を弾く memo と、
 * 「最前面を閉じる」の解決を兼ねる。shallowRef なのは要素を reactive proxy で包まないため。
 */
const openSurfaces = shallowRef<HTMLElement[]>([]);

/** サーフェスごとの close 要求。登録は `useSurface`。 */
const closeHandlers = new Map<HTMLElement, () => void>();

/** 常時最前面に留める要素 (module docstring の pin セクション)。 */
const pinnedSurfaces = new Set<HTMLElement>();

/** 開いているサーフェスが 1 枚でもあるか (close コマンドの when 条件の source)。 */
export const hasOpenSurface = computed(() => openSurfaces.value.length > 0);

/** el を前面順の末尾へ移す (既にあれば取り除いてから積む)。 */
function moveToFront(el: HTMLElement): void {
  openSurfaces.value = [...openSurfaces.value.filter((s) => s !== el), el];
}

/**
 * close 要求の宛先を登録する。開閉とは独立で mount 中ずっと登録されたまま
 * (開いているかどうかは openSurfaces が持つ)。
 */
export function registerSurfaceClose(el: HTMLElement, requestClose: () => void): void {
  closeHandlers.set(el, requestClose);
}

export function unregisterSurfaceClose(el: HTMLElement): void {
  closeHandlers.delete(el);
}

/**
 * 最前面のサーフェスに close を要求する。閉じるものが無ければ false。
 *
 * モーダル / メニューが開いていれば譲る (module docstring)。メニューの判定は「開いている
 * popover のうち、サーフェスでも pin でもないもの」— 種類を列挙するのではなく、自分が
 * 知っているものの補集合として引く。
 */
export function closeFrontSurface(): boolean {
  const front = openSurfaces.value.at(-1);
  if (front === undefined) return false;
  if (document.querySelector("dialog[open]") !== null) return false;
  const foreignPopoverOpen = [...document.querySelectorAll<HTMLElement>(":popover-open")].some(
    (el) => !openSurfaces.value.includes(el) && !pinnedSurfaces.has(el),
  );
  if (foreignPopoverOpen) return false;
  const requestClose = closeHandlers.get(front);
  if (requestClose === undefined) {
    // 登録漏れ。close が黙って効かない状態になるため観察ログを残す
    console.error("[topLayerSurface] closeFrontSurface: no close handler for front surface");
    return false;
  }
  requestClose();
  return true;
}

/** pin 済みを top layer の最後へ積み直す。開いていないものは対象外。 */
function restackPinned(): void {
  for (const el of pinnedSurfaces) {
    if (!el.matches(":popover-open")) continue;
    el.hidePopover();
    el.showPopover();
  }
}

/** サーフェスを開く。show 順の規則により、開いたサーフェスがそのまま最前面になる。 */
export function showSurface(el: HTMLElement): void {
  el.showPopover();
  moveToFront(el);
  restackPinned();
}

/** サーフェスを閉じる。 */
export function hideSurface(el: HTMLElement): void {
  el.hidePopover();
  openSurfaces.value = openSurfaces.value.filter((s) => s !== el);
}

/**
 * サーフェスを最前面へ持ち上げる。閉じている / 既に最前面なら no-op。
 *
 * 呼び出し側が満たすべき条件は 2 つ。経路によって満たし方が変わるため、ここでは条件だけを置く。
 *
 * - **ポインタ操作中に呼ぶならキャプチャフェーズで同期に**呼ぶ。バブリング後や非同期にずらすと、
 *   内側の要素が既に取った pointer capture より後に display 切り替えが走り、ドラッグ /
 *   リサイズの開始と競合しうる (クリック経路は `useSurface` がこれを担う)
 * - **対象の中にフォーカスがあるなら、行き先を用意する**。`hidePopover()` がいったん外へ落とす
 *   ため、放置するとフォーカスが body へ抜ける。クリック経路は pointerdown の既定動作が同じ
 *   サーフェス内へ戻すので追加の手当てが要らない。それ以外の経路 (preview の reveal 等) は
 *   呼び出し側が明示的にフォーカスを移す (MainLayout のフォーカス移送 watch)
 */
export function raiseSurface(el: HTMLElement): void {
  if (openSurfaces.value.at(-1) === el || !el.matches(":popover-open")) return;
  el.hidePopover();
  el.showPopover();
  moveToFront(el);
  restackPinned();
}

/** 常時最前面に留める要素として登録する (module docstring の pin セクション)。 */
export function pinSurface(el: HTMLElement): void {
  pinnedSurfaces.add(el);
}

/** pin を解除する (要素の unmount 時。detached な要素への参照を残さない)。 */
export function unpinSurface(el: HTMLElement): void {
  pinnedSurfaces.delete(el);
}
