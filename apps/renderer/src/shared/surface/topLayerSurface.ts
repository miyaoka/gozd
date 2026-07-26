/**
 * top layer に載る「サーフェス」(preview / server list / event log の右ドックパネル、undock された
 * 各パネル) の重ね順を扱う。
 *
 * 重ね順の規則は「最後に触ったものが最前面」。ウィンドウマネージャの click-to-front と同じで、
 * 開いた / クリックしたサーフェスが手前に来る。サーフェス間に固定の優先順位は持たない。
 *
 * top layer の順序は `showPopover()` の**呼び出し順**が SSOT で、z-index では越えられない。
 * したがって前面化は「hide してから show し直す」しか手段がなく、開閉と前面化を同じ 1 箇所に
 * 集約しないと「今どれが最前面か」を誰も知らない状態になる。本モジュールが最前面の 1 枚を
 * 覚えるのは、既に最前面のサーフェスへの再 show (= 無意味な hide/show) を弾くためで、
 * 順序そのものの SSOT はあくまでブラウザ側の top layer にある。
 *
 * この hide → show は見た目のコストを持たない。スタイル再計算は次のレンダリング更新まで
 * 遅延され、2 つの呼び出しの間にジオメトリ読み取り (強制同期レイアウト) を挟まないため、
 * `display: none` の状態は一度も具現化しない。よって box が破棄されず、スクロール位置の
 * リセットも入場アニメーションの再生も起きない。一方 top layer の順序はレンダリングでは
 * なくドキュメントの状態なので、具現化を待たずに変わる。
 *
 * フォーカスの退避は持たない。`hidePopover()` はフォーカスがそのサーフェス内にあるときだけ
 * 外へ落とすが、それが起きる経路ではクリックの既定動作 (伝播完了後にクリック先へフォーカスを
 * 移す) が同じサーフェス内へ入れ直す。サーフェスの root はいずれも focusable なので、
 * 行き先が無くて body へ落ちることもない。
 *
 * サーフェスに含めないもの: メニュー (`popover="auto"`) / モーダル / トースト。これらは
 * サーフェスより常に手前でよく、順序の入れ替えを持たない。表示のたびに show されるため
 * 自然と手前に載る。
 */

/** 最前面のサーフェス。無駄な hide/show を弾くための memo (詳細は module docstring)。 */
let frontSurface: HTMLElement | undefined;

/** サーフェスを開く。show 順の規則により、開いたサーフェスがそのまま最前面になる。 */
export function showSurface(el: HTMLElement): void {
  el.showPopover();
  frontSurface = el;
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
}
