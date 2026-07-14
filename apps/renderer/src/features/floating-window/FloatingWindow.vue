<doc lang="md">
pin されたコンテンツ 1 件のフローティングウィンドウの汎用シェル。

ドラッグ移動 / 8 方位リサイズ / drag handoff / ビューポート内クランプ / 初期サイズ換算を
担い、ヘッダ内容と本文は slot で consumer (PinnedLogWindow / PinnedPreviewWindow) が
差し込む。本文 slot は `min-h-0 flex-1` の scroll container を consumer 側が持つ契約
(kind 別の背景・overflow 方針は consumer の関心のため)。

ウィンドウ操作ボタンはヘッダ右上の 1 グループに集約する: consumer 固有のアクションは
`actions` slot、共通の close はシェルが持ち、同一行に横並びになる。コードの所有権
(シェル / consumer) の境界を画面配置に漏らさないための契約で、consumer が header slot
内の任意の行にボタンを置くとウィンドウ操作が画面上に散る。actions slot に置くボタンは
`@pointerdown.stop` でヘッダのドラッグ開始から除外する (close ボタンと同じ規律)。

- ドラッグ移動は pointer capture ではなく window レベルの listener で追従する。capture に
  しないのは drag handoff のため: pin 元ヘッダのドラッグで pin する経路では、掴んでいた
  要素が pin と同時に消えて capture が死ぬ。window listener なら dragState を立てるだけで
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
- plain `position: fixed` 要素で popover / dialog の top layer には載せない。モーダルや
  menu が常にウィンドウより手前という既存のオーバーレイ順序ポリシー (ArcadeLayer 参照) に従う
</doc>

<script setup lang="ts">
import { TITLEBAR_HEIGHT } from "@gozd/shared";
import { useEventListener } from "@vueuse/core";
import { onMounted, useTemplateRef } from "vue";
import { deriveResize, type ResizeBounds, type ResizeDirection } from "./floatingWindowResize";
import type { PinDragHandoff } from "./useFloatingWindows";
import IconLucideX from "~icons/lucide/x";

interface Props {
  x: number;
  y: number;
  z: number;
  bodyWidth: number;
  bodyHeight: number;
  /** pin 元から引き継いだドラッグ (consumer が takeHandoff() で消費して渡す)。 */
  handoff?: PinDragHandoff;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  move: [x: number, y: number];
  activate: [];
  close: [];
}>();

/** ドラッグ / 描画クランプ時に画面内へ残すヘッダの掴み代 (px)。 */
const GRAB_MARGIN = 80;

const rootRef = useTemplateRef<HTMLElement>("root");
const headerRef = useTemplateRef<HTMLElement>("header");

// ドラッグ中の pointer と、pointer からウィンドウ原点へのオフセット。ドラッグ中のみ定義。
let dragState: { pointerId: number; offsetX: number; offsetY: number } | undefined;

// 初期サイズは mount 時に一度だけ inline style へ書き、:style にはバインドしない。
// Vue の style patch はバインドオブジェクトの全キーを毎パッチ再適用するため、バインドすると
// ドラッグ (left / top 更新) のたびに width / height が初期値で再セットされ、リサイズ
// ハンドルが書いた値を巻き戻してしまう。
// bodyWidth / bodyHeight prop は本文 (スクロール面) のサイズなので、実測した自ヘッダ高
// と root の border 厚 (offset と client の差。overflow-hidden なので scrollbar は混ざらない)
// を足して border-box の総サイズへ換算する。
onMounted(() => {
  const root = rootRef.value;
  const header = headerRef.value;
  if (root === null || header === null) return;
  const borderX = root.offsetWidth - root.clientWidth;
  const borderY = root.offsetHeight - root.clientHeight;
  root.style.width = `${props.bodyWidth + borderX}px`;
  // ヘッダ高は幅確定後に測る (truncate 前提で折り返しはしないが、layout を width 決定後に
  // 揃えておく)。offsetHeight はヘッダ自身の border-b を含む。
  root.style.height = `${props.bodyHeight + header.offsetHeight + borderY}px`;
  // pin 元ヘッダのドラッグから pin された場合はドラッグ中状態で始まり、掴んだままの
  // pointer の pointermove (window listener) が引き続きこのウィンドウを動かす。
  dragState = props.handoff;
});

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
    class="fixed flex max-h-[80vh] min-h-16 max-w-[90vw] min-w-64 flex-col overflow-hidden rounded-md border border-border-strong bg-background shadow-xl"
    :style="{
      left: `min(${x}px, calc(100vw - ${GRAB_MARGIN}px))`,
      top: `clamp(var(--titlebar-height), ${y}px, calc(100vh - ${GRAB_MARGIN}px))`,
      zIndex: z,
    }"
    @pointerdown="emit('activate')"
  >
    <!-- ヘッダ全体がドラッグハンドル。内容は consumer の slot。 -->
    <header
      ref="header"
      class="flex shrink-0 cursor-grab items-start gap-2 border-b border-border bg-panel px-2 py-1 select-none active:cursor-grabbing"
      @pointerdown="onHeaderPointerDown"
    >
      <slot name="header" />
      <!-- ウィンドウ操作の集約グループ (doc 参照)。pointerdown.stop でヘッダのドラッグ開始に
           食われないようにする -->
      <div class="flex shrink-0 items-center gap-1">
        <slot name="actions" />
        <button
          type="button"
          aria-label="Close"
          class="grid size-5 shrink-0 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
          @pointerdown.stop
          @click="emit('close')"
        >
          <IconLucideX class="size-3.5" />
        </button>
      </div>
    </header>

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
