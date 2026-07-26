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
 * フォーカスの退避は持たない。`hidePopover()` はフォーカスがその要素の中にあるときだけ外へ
 * 落とすが、`raiseSurface` が hide する相手は定義上「最前面でないサーフェス」であり、
 * フォーカスは最後に触った最前面サーフェス側 (またはサーフェス外) にいるため、hide 対象の
 * 中にフォーカスが無い。pin の積み直しだけはフォーカス中の要素を hide しうるが、積み直しの
 * 発火源はサーフェスへのクリックであり、その既定動作がクリック先へフォーカスを移す。
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
 * 呼び出しは pointerdown の**キャプチャ**フェーズから同期で行う契約。バブリング後や非同期に
 * ずらすと、内側の要素が既に取った pointer capture より後に display 切り替えが走り、
 * ドラッグ / リサイズの開始と競合しうる。
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
