<doc lang="md">
undock されたコンテンツ 1 件をアプリ画面内のパネルとして描く汎用シェル (in-app
presentation)。UndockedWindow から使われ、consumer が直接触ることはない。

ドラッグ移動 / 8 方位リサイズ / drag handoff / ビューポート内クランプ / 初期サイズ換算を
担い、ヘッダ内容と本文は slot で受ける。本文 slot は `min-h-0 flex-1` の scroll container を
差し込む側が持つ契約 (背景・overflow 方針は中身の関心のため)。

ヘッダ枠は両 presentation 共通の UndockedWindowHeader が持ち、シェルは自分のウィンドウ操作
ボタン (promote / close) を trailing slot に足すだけ。actions slot に置くボタンは
`@pointerdown.stop` でヘッダのドラッグ開始から除外する (シェルのボタンと同じ規律)。

promote ボタンは「このパネルを別 OS ウィンドウへ昇格させる」要求で、実測した自分の
コンテンツ rect をスクリーン座標へ換算した `ChildWindowInit` を載せて emit する。昇格の
実行主体はシェルではない (state の書き換えは store、中身の描画は consumer) が、rect を
測れるのは自分だけなので測定はここが担う。

Cmd+S の宛先はフォーカスで決める: root を `tabindex="-1"` で focusable にし、focusin /
focusout を floatingWindowCommands の activate / deactivate に変換する。これで
`floatingWindowFocused` の when 条件で Cmd+S がこのパネル宛に解決され、他サーフェスの save を
誤射しない (child window と同じ規律)。close もフォーカスで決まるが、宛先解決はサーフェス共通の
`surface.closeFocused` が持つため、パネル側は `useSurface` に close 要求を登録するだけ。

- ドラッグ移動は pointer capture ではなく window レベルの listener で追従する。capture に
  しないのは drag handoff のため: undock 元ヘッダのドラッグで undock する経路では、掴んでいた
  要素が undock と同時に消えて capture が死ぬ。window listener なら dragState を立てるだけで
  同じ pointer のドラッグを途切れず継続できる (`handoff` prop はこの引き継ぎで、あれば
  pointerdown なしでドラッグ中状態から始まる)。リサイズは handoff が存在しないため
  capture 方式でよい
- x / y prop は「ユーザーが望んだ位置」で、描画時に CSS でビューポート内へ射影する。
  state を書き換えないため、アプリウィンドウを縮めてパネルが押し戻されても、戻せば
  元の位置に復帰する。ビューポート変化への追従は CSS が担い、resize listener を持たない
- 描画位置が射影クランプで保存座標からずれ得るため、ドラッグ / リサイズの基準は
  保存座標ではなく実測 rect から取る (保存座標基準だと、押し戻された状態で掴んだ瞬間に
  パネルが保存座標側へ跳ねる)
- サイズの不変量は本文 (スクロール面) サイズで、総サイズはヘッダ実測を足して mount 時に
  換算する (本文サイズを不変量にする理由は useFloatingWindows の doc 参照)。mount 後の
  サイズ SSOT はリサイズハンドラが書く inline style で、Vue は以後このプロパティに触らない
- 既知の境界例外: 左/上辺リサイズで逆算した x / y が描画時のビューポート射影クランプに
  当たると、アンカーのはずの下端 / 右端が滑りうる (実質不可視の範囲に限られる)。射影まで
  含めたサイズ再導出は算術の複雑化に見合わないため受容する
- root 自身が `popover="manual"` のサーフェス 1 枚。undock 元のドックパネル (preview 等) と
  同じ top layer に並び、`shared/surface` の click-to-front 規則で重ね順が決まる。z-index は
  持たない — top layer の順序は show 呼び出し順が SSOT で z-index では越えられないため、
  パネル間もパネルとドックパネルの間も同じ 1 つの規則で並ぶ
- 前面化はクリック経路 (`useSurface`) だけを持つ。pointerdown の**キャプチャ**フェーズで同期に
  呼ぶのは、リサイズハンドルが既に取った pointer capture より後に display 切り替えを走らせないため
- UA の `[popover]` 既定値のうち、位置 (`inset`) / `margin` / `padding` / 文字色は自前の値で
  打ち消す。サイズと配置は inline style と Tailwind class が持つ
</doc>

<script setup lang="ts">
import { TITLEBAR_HEIGHT } from "@gozd/shared";
import { useEventListener } from "@vueuse/core";
import { onMounted, onUnmounted, useTemplateRef } from "vue";
import { useSurface } from "../../shared/surface";
import { type ChildWindowInit, toChildWindowInit } from "./childWindowInit";
import {
  activateFloatingWindow,
  deactivateFloatingWindow,
  type FloatingWindowHandle,
} from "./floatingWindowCommands";
import { deriveResize, type ResizeBounds, type ResizeDirection } from "./floatingWindowResize";
import UndockedWindowHeader from "./UndockedWindowHeader.vue";
import type { UndockDragHandoff } from "./useFloatingWindows";
import IconLucideX from "~icons/lucide/x";
import IconMdiOpenInNew from "~icons/mdi/open-in-new";

interface Props {
  x: number;
  y: number;
  contentWidth: number;
  contentHeight: number;
  /** undock 元から引き継いだドラッグ (consumer が takeHandoff() で消費して渡す)。 */
  handoff?: UndockDragHandoff;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  move: [x: number, y: number];
  /** 閉じたい要求 (close ボタン / ESC / Cmd+W)。パネル自身は state を消す権限を持たないため、
   * close ではなく常に「要求」を emit する。 */
  closeRequested: [];
  /** cmd+s (floatingWindow.save) の要求。保存の可否・実処理は consumer の知識。 */
  saveRequested: [];
  /** 別 OS ウィンドウへの昇格要求 (doc 参照)。init は実測コンテンツ rect のスクリーン座標換算。 */
  promote: [init: ChildWindowInit];
}>();

// ==== キー入力の宛先 (doc 参照) ====
const focusHandle: FloatingWindowHandle = {
  requestSave: () => emit("saveRequested"),
};
function onFocusIn() {
  activateFloatingWindow(focusHandle);
}
function onFocusOut(event: FocusEvent) {
  // 子要素間のフォーカス移動 (Monaco → ボタン等) では解除しない
  const next = event.relatedTarget;
  if (next instanceof Node && rootRef.value?.contains(next) === true) return;
  deactivateFloatingWindow(focusHandle);
}
// フォーカスされたまま unmount されると focusout が飛ばないことがあるため確実に解除する
onUnmounted(() => deactivateFloatingWindow(focusHandle));

/** ドラッグ / 描画クランプ時に画面内へ残すヘッダの掴み代 (px)。 */
const GRAB_MARGIN = 80;

const rootRef = useTemplateRef<HTMLElement>("root");
// パネルは mount = 開いている。entry が消えれば unmount されるので close 側の state は持たない
const { raise } = useSurface(rootRef, {
  isOpen: () => true,
  requestClose: () => emit("closeRequested"),
});

// ドラッグ中の pointer と、pointer からウィンドウ原点へのオフセット。ドラッグ中のみ定義。
let dragState: { pointerId: number; offsetX: number; offsetY: number } | undefined;

// 初期サイズは mount 時に一度だけ inline style へ書き、:style にはバインドしない。
// Vue の style patch はバインドオブジェクトの全キーを毎パッチ再適用するため、バインドすると
// ドラッグ (left / top 更新) のたびに width / height が初期値で再セットされ、リサイズ
// ハンドルが書いた値を巻き戻してしまう。
// contentWidth / contentHeight prop はヘッダを除いた中身のサイズなので、実測した自ヘッダ高
// と root の border 厚 (offset と client の差。overflow-hidden なので scrollbar は混ざらない)
// を足して border-box の総サイズへ換算する。
onMounted(() => {
  const root = rootRef.value;
  // ヘッダは自テンプレートの先頭子 (子コンポーネントの $el を覗くと、その root 構造の変化で
  // 実測が黙って飛ぶ)
  const header = root?.firstElementChild;
  if (root === null || !(header instanceof HTMLElement)) {
    // 到達すると初期サイズ換算と handoff の武装が同時に失われ、パネルが min サイズで出て
    // ドラッグも始まらない。ユーザーに見える破綻を診断不能にしないため観察ログを残す
    // root null と header 非要素のどちらでも「実測できない」に畳む (到達不能な条件のために
    // 分岐を増やさない)
    console.error("[FloatingWindow] initial size skipped: header element not measurable");
    return;
  }
  const borderX = root.offsetWidth - root.clientWidth;
  const borderY = root.offsetHeight - root.clientHeight;
  root.style.width = `${props.contentWidth + borderX}px`;
  // ヘッダ高は幅確定後に測る (truncate 前提で折り返しはしないが、layout を width 決定後に
  // 揃えておく)。offsetHeight はヘッダ自身の border-b を含む。
  root.style.height = `${props.contentHeight + header.offsetHeight + borderY}px`;
  // undock 元ヘッダのドラッグから undock された場合はドラッグ中状態で始まり、掴んだままの
  // pointer の pointermove (window listener) が引き続きこのウィンドウを動かす。
  dragState = props.handoff;
});

// promote ボタン: 実測した自分のコンテンツ rect (border 内側) をスクリーン座標へ換算して
// emit する。サイズを client (コンテンツボックス) で測るのは、昇格先の OS ウィンドウが同じ
// 「ヘッダ + 本文」構成を同じ幅で描くため、コンテンツ総高をそのまま渡せば本文高が保たれる
// ため。原点は border-box 基準のままで、border 1px 分のずれは補正しない。
function onPromote() {
  const root = rootRef.value;
  if (root === null) return;
  const rect = root.getBoundingClientRect();
  emit(
    "promote",
    toChildWindowInit(
      {
        left: rect.left,
        top: rect.top,
        width: root.clientWidth,
        height: root.clientHeight,
      },
      {
        screenX: window.screenX,
        screenY: window.screenY,
        chromeY: window.outerHeight - window.innerHeight,
      },
    ),
  );
}

// 8 方位の不可視ハンドル (ネイティブ `resize: both` は仕様で右下グリップ固定のため
// 使えない)。辺は 4px 幅、角は 8px 角。root が overflow-hidden のため全ハンドルを内縁に
// 置く。辺は角の領域 (inset 2 = 8px) を避けて重なりを作らない。
const RESIZE_HANDLES: { dir: ResizeDirection; class: string }[] = [
  { dir: "n", class: "inset-x-2 top-0 h-1 cursor-n-resize" },
  { dir: "s", class: "inset-x-2 bottom-0 h-1 cursor-s-resize" },
  { dir: "e", class: "inset-y-2 right-0 w-1 cursor-e-resize" },
  { dir: "w", class: "inset-y-2 left-0 w-1 cursor-w-resize" },
  { dir: "ne", class: "top-0 right-0 size-2 cursor-ne-resize" },
  { dir: "nw", class: "top-0 left-0 size-2 cursor-nw-resize" },
  { dir: "se", class: "right-0 bottom-0 size-2 cursor-se-resize" },
  { dir: "sw", class: "bottom-0 left-0 size-2 cursor-sw-resize" },
];

// リサイズ中の状態。pointerdown 時の実測 rect を基準に pointer の delta で導出する。
// min/max は root の Tailwind class (CSS) が SSOT で、pointerdown 時に computed style の
// px 解決値を写し取る (max-w-[90vw] 等の相対値もこの時点の px に解決される)。CSS と JS で
// クランプ値がずれると、左/上辺リサイズで CSS だけが勝った瞬間にアンカー辺が滑る。
// リサイズ中のみ定義。
let resizeState:
  | {
      pointerId: number;
      dir: ResizeDirection;
      startX: number;
      startY: number;
      startRect: DOMRect;
      bounds: ResizeBounds;
    }
  | undefined;

function onResizePointerDown(event: PointerEvent, dir: ResizeDirection) {
  if (event.button !== 0) return;
  const root = rootRef.value;
  if (root === null) return;
  const style = getComputedStyle(root);
  resizeState = {
    pointerId: event.pointerId,
    dir,
    startX: event.clientX,
    startY: event.clientY,
    startRect: root.getBoundingClientRect(),
    bounds: {
      minWidth: parseFloat(style.minWidth),
      maxWidth: parseFloat(style.maxWidth),
      minHeight: parseFloat(style.minHeight),
      maxHeight: parseFloat(style.maxHeight),
      // 上端の下限はタイトルバー (アプリの drag 領域) 直下。ドラッグの y クランプと同じ
      topMin: TITLEBAR_HEIGHT,
    },
  };
  // ドラッグ移動 (window listener 方式) と違い、リサイズには drag handoff が無いので
  // pointer capture が使える。速いポインタ移動でハンドルを追い越しても event が届き続ける
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onResizePointerMove(event: PointerEvent) {
  if (resizeState === undefined || event.pointerId !== resizeState.pointerId) return;
  const root = rootRef.value;
  if (root === null) return;
  const { dir, startX, startY, startRect, bounds } = resizeState;
  // 反対辺アンカーの算術は deriveResize (純関数) に委譲。x/y の基準は保存座標では
  // なく実測 rect (描画クランプで押し戻されていてもその場から動く。ヘッダドラッグの
  // オフセット実測と同じ理由)。
  const { width, height, x, y } = deriveResize(
    dir,
    event.clientX - startX,
    event.clientY - startY,
    startRect,
    bounds,
  );
  if (width !== undefined) root.style.width = `${width}px`;
  if (height !== undefined) root.style.height = `${height}px`;
  if (x !== undefined || y !== undefined) {
    emit("move", x ?? props.x, y ?? props.y);
  }
}

function onResizePointerEnd(event: PointerEvent) {
  if (resizeState?.pointerId !== event.pointerId) return;
  resizeState = undefined;
}

function onHeaderPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const root = rootRef.value;
  if (root === null) return;
  // オフセットは保存座標 (props.x / y) ではなく実測 rect 基準。描画クランプで押し戻されて
  // いる状態から掴んでも、パネルが保存座標側へ跳ねずその場から動き出す。
  const rect = root.getBoundingClientRect();
  dragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
}

// move / up は window で受ける (doc 参照: handoff のため capture 方式にしない)。
// 常時登録しつつ dragState の有無でゲートする。
useEventListener(window, "pointermove", (event: PointerEvent) => {
  if (dragState === undefined || event.pointerId !== dragState.pointerId) return;
  // ボタンが押されていないならそのドラッグは終わっている。handoff は mount 時に一度だけ
  // 武装するが、prop は consumer が setup で 1 回消費した値を渡し続けるため、再 mount
  // (昇格失敗の demote) で終了済みのドラッグが蘇る。pointerup が別ウィンドウに取られて
  // 届かなかった取りこぼしも同じ形で閉じる (touch / pen は接触中 buttons !== 0)
  if (event.buttons === 0) {
    dragState = undefined;
    return;
  }
  const root = rootRef.value;
  if (root === null) return;
  // ヘッダが掴めない位置に逃げないようクランプする。x は左右に GRAB_MARGIN 分だけ
  // 残してはみ出し可。y はタイトルバー (アプリの drag 領域) の直下から画面下端の
  // 手前までに制限する。
  const minX = GRAB_MARGIN - root.offsetWidth;
  const maxX = window.innerWidth - GRAB_MARGIN;
  const maxY = window.innerHeight - GRAB_MARGIN;
  const x = Math.min(maxX, Math.max(minX, event.clientX - dragState.offsetX));
  const y = Math.min(maxY, Math.max(TITLEBAR_HEIGHT, event.clientY - dragState.offsetY));
  emit("move", x, y);
});

function endDrag(event: PointerEvent) {
  if (dragState?.pointerId !== event.pointerId) return;
  dragState = undefined;
}

useEventListener(window, "pointerup", endDrag);
useEventListener(window, "pointercancel", endDrag);
</script>

<template>
  <!-- left / top は「望んだ位置」を CSS でビューポート内へ射影する。
       上限 (右端 / 下端) はビューポート縮小で変わるため CSS 側でクランプし、
       下限のうち left 側だけは自要素幅に依存する (幅 - GRAB_MARGIN まではみ出し可) ため
       CSS では書けず、ドラッグ時の JS クランプに委ねる。top の下限はタイトルバー
       (アプリの drag 領域) 直下。 -->
  <section
    ref="root"
    popover="manual"
    tabindex="-1"
    class="fixed inset-auto m-0 max-h-[80vh] min-h-16 max-w-[90vw] min-w-64 flex-col overflow-hidden rounded-md border border-border-strong bg-background p-0 text-foreground shadow-xl outline-hidden [&:popover-open]:flex"
    :style="{
      left: `min(${x}px, calc(100vw - ${GRAB_MARGIN}px))`,
      top: `clamp(var(--titlebar-height), ${y}px, calc(100vh - ${GRAB_MARGIN}px))`,
    }"
    @pointerdown.capture="raise()"
    @focusin="onFocusIn()"
    @focusout="onFocusOut"
  >
    <!-- ヘッダ全体がドラッグハンドル。枠は共通の UndockedWindowHeader、内容は slot。
         シェルのボタンは trailing に置き、pointerdown.stop でドラッグ開始に食われないようにする -->
    <UndockedWindowHeader grabbable @pointerdown="onHeaderPointerDown">
      <template #header>
        <slot name="header" />
      </template>
      <template #actions>
        <slot name="actions" />
      </template>
      <template #trailing>
        <button
          type="button"
          aria-label="Open in separate window"
          title="Open in separate window"
          class="grid size-5 shrink-0 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
          @pointerdown.stop
          @click="onPromote()"
        >
          <IconMdiOpenInNew class="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Close"
          class="grid size-5 shrink-0 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
          @pointerdown.stop
          @click="emit('closeRequested')"
        >
          <IconLucideX class="size-3.5" />
        </button>
      </template>
    </UndockedWindowHeader>

    <slot />

    <!-- 8 方位の不可視リサイズハンドル。DOM 末尾に置きヘッダ / 本文より手前で pointer を
         受ける。root の pointerdown (activate) はバブリングでそのまま効かせる -->
    <div
      v-for="handle in RESIZE_HANDLES"
      :key="handle.dir"
      class="absolute touch-none"
      :class="handle.class"
      @pointerdown="onResizePointerDown($event, handle.dir)"
      @pointermove="onResizePointerMove"
      @pointerup="onResizePointerEnd"
      @pointercancel="onResizePointerEnd"
    />
  </section>
</template>
