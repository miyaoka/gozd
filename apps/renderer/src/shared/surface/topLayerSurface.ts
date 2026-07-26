/**
 * top layer に載る「サーフェス」(preview / server list / event log / notification center の
 * 右ドックパネル、undock された各パネル) の重ね順を扱う。
 *
 * 重ね順の規則は「最後に触ったものが最前面」。ウィンドウマネージャの click-to-front と同じで、
 * 開いた / クリックしたサーフェスが手前に来る。サーフェス間に固定の優先順位は持たない。
 *
 * top layer の順序は `showPopover()` の**呼び出し順**が SSOT で、z-index では越えられない。
 * したがって前面化は「hide してから show し直す」しか手段がなく、開閉と前面化を同じ 1 箇所に
 * 集約しないと「今どれが最前面か」を誰も知らない状態になる。本モジュールが最前面の 1 枚を
 * 覚えるのは、既に最前面のサーフェスへの再 show (= 無意味な hide/show) を弾くためで、
 * 順序そのものの SSOT はあくまでブラウザ側の top layer にある。この memo が嘘にならないよう、
 * サーフェスの開閉は必ず本モジュールを通す (素の `showPopover()` を呼ぶと memo が腐り、
 * 以後その要素への `raiseSurface` が黙って no-op になる)。
 *
 * この hide → show は見た目のコストを持たない。スタイル再計算は次のレンダリング更新まで
 * 遅延され、2 つの呼び出しの間にジオメトリ読み取り (強制同期レイアウト) を挟まないため、
 * `display: none` の状態は一度も具現化しない。よって box が破棄されず、スクロール位置の
 * リセットも入場アニメーションの再生も起きない。一方 top layer の順序はレンダリングでは
 * なくドキュメントの状態なので、具現化を待たずに変わる。
 *
 * フォーカスの退避は本モジュールでは持たない。`hidePopover()` はフォーカスがその要素の中に
 * あるときだけ外へ落とすが、積み直しの対象にフォーカスがある状況は普通に起きる (前面化は
 * クリックだけでなく open でも起きるため、「最前面 = フォーカスがある」は成立しない。例:
 * preview を編集中にタイトルバーのボタンで別パネルを開くとフォーカスは preview に残る)。
 * 落ちたフォーカスの行き先は経路ごとに違うため、**呼び出し側が持つ**契約にしている
 * (`raiseSurface` の docstring)。
 *
 * サーフェスの root はいずれも `tabindex="-1"` + `outline-hidden` を持つ。クリック経路が
 * フォーカスの行き先として root を使うためで、root が focusable でないとフォーカスが body へ
 * 抜ける (既定動作は最も近い focusable な祖先を選ぶ)。tab 到達不能な面へのルーティングなので
 * focus ring は出さない。`outline-none` ではなく `outline-hidden` なのは、forced-colors mode
 * では outline を残すため (Tailwind v4 で意味が分かれた 2 つのうち後者が従来の挙動)。
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

/** 最前面のサーフェス。無駄な hide/show を弾くための memo (詳細は module docstring)。 */
let frontSurface: HTMLElement | undefined;

/** 常時最前面に留める要素 (module docstring の pin セクション)。 */
const pinnedSurfaces = new Set<HTMLElement>();

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
  frontSurface = el;
  restackPinned();
}

/** サーフェスを閉じる。 */
export function hideSurface(el: HTMLElement): void {
  el.hidePopover();
  if (frontSurface === el) frontSurface = undefined;
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
  if (frontSurface === el || !el.matches(":popover-open")) return;
  el.hidePopover();
  el.showPopover();
  frontSurface = el;
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
