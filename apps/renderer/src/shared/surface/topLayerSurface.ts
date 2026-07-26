/**
 * top layer に載る「サーフェス」(preview / server list / event log / notification center の
 * 右ドックパネル、undock された各パネル) の重ね順・フォーカス・閉じる対象を扱う。
 *
 * ## 2 つの規則
 *
 * - **重ね順**: 最後に触ったものが最前面。開く / クリックする、どちらも「触った」に含む。
 *   ウィンドウマネージャの click-to-front と同じで、サーフェス間に固定の優先順位は持たない
 * - **閉じる対象**: 常にフォーカスがあるもの。ESC / Cmd+W はフォーカスを含むサーフェスを閉じる
 *
 * この 2 つを繋ぐのが**フォーカスは前面に追従する**という不変条件で、本モジュールが維持する。
 * 前面化のたびにそのサーフェスへフォーカスを入れ、閉じたら次の前面へ移す。結果として ESC の
 * 連打は前面から順に閉じていくが、それは規則ではなく帰結である。規則を「最前面を閉じる」に
 * 置き換えてはいけない — ターミナルにフォーカスがあるときの Cmd+W は、サーフェスが開いていても
 * ターミナルの pane を閉じる (閉じる対象はフォーカスが決める) という意味論が壊れる。
 *
 * ## top layer の制約
 *
 * top layer の順序は `showPopover()` の**呼び出し順**が SSOT で、z-index では越えられない。
 * したがって前面化は「hide してから show し直す」しか手段がなく、開閉・前面化・close の宛先
 * 解決を同じ 1 箇所に集約しないと「今どれが前面か / どれを閉じるか」を誰も知らない状態になる。
 * 本モジュールが前面順を控えるのはこのためで、順序そのものの SSOT はあくまでブラウザ側の
 * top layer にある。控えが嘘にならないよう、開閉と前面化は barrel から export せず `useSurface`
 * に閉じる (素の `showPopover()` を呼ぶと控えが腐り、前面化が黙って no-op になり close の宛先も
 * ずれる。規律を doc 頼みにせずモジュール境界で強制する)。
 *
 * この hide → show は見た目のコストを持たない。スタイル再計算は次のレンダリング更新まで
 * 遅延され、2 つの呼び出しの間にジオメトリ読み取り (強制同期レイアウト) を挟まないため、
 * `display: none` の状態は一度も具現化しない。よって box が破棄されず、スクロール位置の
 * リセットも入場アニメーションの再生も起きない。一方 top layer の順序はレンダリングでは
 * なくドキュメントの状態なので、具現化を待たずに変わる。
 *
 * ## フォーカスの行き先
 *
 * サーフェスの root はいずれも `tabindex="-1"` + `outline-hidden` を持つ。フォーカス追従の
 * 行き先として root を使うためで、root が focusable でないとフォーカスが body へ抜ける。
 * tab 到達不能な面へのルーティングなので focus ring は出さない (`outline-none` ではなく
 * `outline-hidden` なのは forced-colors mode で outline を残すため。Tailwind v4 で意味が
 * 分かれた 2 つのうち後者が従来の挙動)。
 *
 * 前面化してもサーフェス内の入力先は変えない (Monaco 編集中に前面化しても打鍵が続く)。積み直しで
 * 一度落ちても元の要素へ戻す — 「落ちない前提で focus を省く」ではないので注意 (機構は
 * surfaceStack の `planRaise` を参照)。
 *
 * サーフェスが 1 枚も無い状態から開くときのフォーカス元を控えておき、最後の 1 枚が閉じたら
 * そこへ戻す (terminal リンクから preview を開いて閉じると terminal に入力が戻る)。
 *
 * ## pin (常時最前面)
 *
 * トーストだけは click-to-front の列に加えず、常にサーフェスより手前へ留める。エラー通知の
 * 一次表示であり、パネルに埋もれると失敗の可視性が落ちるため。`pinSurface()` で登録すると、
 * サーフェスの show / raise のたびに pin 側を積み直して最前面を保つ。
 *
 * メニュー (`popover="auto"`) とモーダル (`<dialog>`) は pin せず、閉じる要求の側で譲る。
 * ESC を消費しないことで UA の light-dismiss / cancel がそのまま働く。
 */
import { computed, shallowRef } from "vue";
import { planHide, planRaise, planShow, type SurfaceOp } from "./surfaceStack";

/** 開いているサーフェスを前面順に持つ (末尾が最前面)。 */
const openSurfaces = shallowRef<HTMLElement[]>([]);

/** サーフェスごとの close 要求。登録は `useSurface`。 */
const closeHandlers = new Map<HTMLElement, () => void>();

/** 常時最前面に留める要素 (module docstring の pin セクション)。 */
const pinnedSurfaces = new Set<HTMLElement>();

/** フォーカスを含むサーフェス。閉じる対象の SSOT。 */
const focusedSurface = shallowRef<HTMLElement | undefined>();

/** サーフェス内にフォーカスがあるか (close コマンドの when 条件の source)。 */
export const hasFocusedSurface = computed(() => focusedSurface.value !== undefined);

/** サーフェスが 1 枚も無い状態から開いたときのフォーカス元。全部閉じたら戻す。 */
let returnFocusEl: HTMLElement | undefined;

/**
 * focus 追跡の listener を 1 度だけ張る。module singleton でアプリの寿命と一致するため
 * dispose しない。
 *
 * focusin / focusout のどちらも microtask へ倒してから読む。focusout の時点では
 * `document.activeElement` がまだ遷移前 / body のことがあり、遷移先が確定していないため。
 */
let focusTrackerInstalled = false;
function installFocusTracker(): void {
  if (focusTrackerInstalled) return;
  focusTrackerInstalled = true;
  const schedule = () => queueMicrotask(syncFocusedSurface);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
}

function syncFocusedSurface(): void {
  const active = document.activeElement;
  focusedSurface.value =
    active instanceof Node ? openSurfaces.value.find((el) => el.contains(active)) : undefined;
}

/** 開いている pin 済み要素 (plan へ渡す入力)。 */
function openPinned(): HTMLElement[] {
  return [...pinnedSurfaces].filter((el) => el.matches(":popover-open"));
}

/** plan が返した操作列を DOM へ流す。順序をそのまま実行するだけで判断はしない。 */
function runOps(ops: readonly SurfaceOp<HTMLElement>[]): void {
  for (const op of ops) {
    if (op.kind === "show") op.el.showPopover();
    else if (op.kind === "hide") op.el.hidePopover();
    else op.el.focus({ preventScroll: true });
  }
}

/** サーフェスを開く。show 順の規則により、開いたサーフェスがそのまま最前面になる。 */
export function showSurface(el: HTMLElement): void {
  installFocusTracker();
  if (openSurfaces.value.length === 0) {
    const active = document.activeElement;
    returnFocusEl = active instanceof HTMLElement ? active : undefined;
  }
  const plan = planShow(openSurfaces.value, el, { pinnedOpen: openPinned() });
  runOps(plan.ops);
  openSurfaces.value = plan.stack;
  syncFocusedSurface();
}

/**
 * サーフェスを閉じる。閉じた面がフォーカスを持っていたときだけ、次の前面サーフェスへ移し、
 * 1 枚も残らなければ開く前の位置へ戻す (フォーカス追従の不変条件。module docstring 参照)。
 *
 * 保持の判定は `hidePopover()` の**前**にしか取れない (後ではフォーカスが body へ落ちている)。
 */
export function hideSurface(el: HTMLElement): void {
  const plan = planHide(openSurfaces.value, el, { hadFocus: el.contains(document.activeElement) });
  runOps(plan.ops);
  openSurfaces.value = plan.stack;
  const restore = returnFocusEl;
  if (plan.clearReturnFocus) returnFocusEl = undefined;
  if (plan.restoreReturnFocus && restore?.isConnected === true) {
    restore.focus({ preventScroll: true });
  }
  syncFocusedSurface();
}

/**
 * サーフェスを最前面へ持ち上げる。閉じている / 既に最前面なら no-op。
 *
 * ポインタ操作から呼ぶときは pointerdown の**キャプチャ**フェーズで同期に呼ぶ。バブリング後や
 * 非同期にずらすと、内側の要素が既に取った pointer capture より後に display 切り替えが走り、
 * ドラッグ / リサイズの開始と競合しうる (クリック経路は `useSurface` が担う)。
 */
export function raiseSurface(el: HTMLElement): void {
  const active = document.activeElement;
  const plan = planRaise(openSurfaces.value, el, {
    isOpen: el.matches(":popover-open"),
    // 積み直しでフォーカスが落ちても元の入力先へ戻せるよう、掴んでいた要素を渡す
    focusedInside: active instanceof HTMLElement && el.contains(active) ? active : undefined,
    pinnedOpen: openPinned(),
  });
  if (plan.ops.length === 0) return;
  runOps(plan.ops);
  openSurfaces.value = plan.stack;
  syncFocusedSurface();
}

/**
 * close 要求の宛先を登録する。開閉とは独立で mount 中ずっと登録されたまま
 * (開いているかどうかは前面順の控えが持つ)。
 */
export function registerSurfaceClose(el: HTMLElement, requestClose: () => void): void {
  closeHandlers.set(el, requestClose);
}

export function unregisterSurfaceClose(el: HTMLElement): void {
  closeHandlers.delete(el);
}

/**
 * フォーカスを含むサーフェスに close を要求する。対象が無ければ false。
 *
 * メニュー / モーダルが開いていれば譲る。判定は「開いている popover のうち、サーフェスでも
 * pin でもないもの」— 種類を列挙するのではなく、自分が知っているものの補集合として引く。
 * false を返せば dispatcher が `preventDefault` を呼ばないため、ESC は UA の light-dismiss /
 * cancel に届く。
 */
export function closeFocusedSurface(): boolean {
  const el = focusedSurface.value;
  if (el === undefined) return false;
  if (document.querySelector("dialog[open]") !== null) return false;
  const foreignPopoverOpen = [...document.querySelectorAll<HTMLElement>(":popover-open")].some(
    (other) => !openSurfaces.value.includes(other) && !pinnedSurfaces.has(other),
  );
  if (foreignPopoverOpen) return false;
  const requestClose = closeHandlers.get(el);
  if (requestClose === undefined) {
    // 登録漏れ。close が黙って効かない状態になるため観察ログを残す
    console.error("[topLayerSurface] closeFocusedSurface: no close handler for focused surface");
    return false;
  }
  requestClose();
  return true;
}

/** 常時最前面に留める要素として登録する (module docstring の pin セクション)。 */
export function pinSurface(el: HTMLElement): void {
  pinnedSurfaces.add(el);
}

/** pin を解除する (要素の unmount 時。detached な要素への参照を残さない)。 */
export function unpinSurface(el: HTMLElement): void {
  pinnedSurfaces.delete(el);
}
