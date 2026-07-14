<doc lang="md">
pin されたセッションログメッセージ 1 件のフローティングウィンドウ。

- ドラッグ移動はヘッダの pointerdown で開始し、window レベルの pointermove / pointerup
  で追従する (`useResize` と同じ document 監視の流儀)。pointer capture 方式にしないのは
  drag handoff のため: popover ヘッダのドラッグで pin する経路では、掴んでいた popover
  要素が pin と同時に unmount されて capture が死ぬ。window listener なら「mount 直後に
  dragState を立てるだけ」で同じ pointer のドラッグを途切れず継続できる
- mount 時に store の takeHandoff() を消費し、あれば pointerdown なしでドラッグ中状態から
  始まる (popover を掴んだ手がそのままウィンドウを掴んでいる状態)
- store の x / y は「ユーザーが望んだ位置」で、描画時に CSS の `min()` / `clamp()` で
  ビューポート内へ射影する。アプリウィンドウを縮めてパネルが見切れても掴み代
  (`GRAB_MARGIN`) が画面内に残り、ウィンドウを戻せば元の位置に復帰する (state を
  書き換えないので位置情報が失われない)。resize listener は持たない — ビューポート
  変化への追従は CSS が担う
- 描画位置がクランプで保存座標からずれ得るため、ドラッグ開始時の掴みオフセットは
  保存座標ではなく root の `getBoundingClientRect` (実測) から取る。保存座標基準に
  すると、押し戻された状態で掴んだ瞬間にパネルが保存座標側へ跳ねる
- 初期サイズは pin 元 popover の本文実測 (store の bodyWidth / bodyHeight) に、mount 時に
  実測した自ヘッダ高 + border を足して総サイズへ換算する (本文サイズを不変量にする理由は
  usePinnedLog の doc 参照)。`:style` にはバインドせず mount 時に一度だけ inline style へ
  書く。Vue の style patch はバインドオブジェクトの全キーを毎パッチ再適用するため、
  バインドするとドラッグ (left / top 更新) のたびに width / height が初期値で再セットされ、
  リサイズハンドルが書いた値を巻き戻してしまう。mount 後のサイズ SSOT はリサイズ
  ハンドラが書く inline width/height で、Vue は以後このプロパティに触らない
- リサイズは 8 方位の不可視ハンドル + pointer capture (ネイティブ `resize: both` は仕様で
  右下グリップ固定のため使えない)。ドラッグ移動と違い capture 方式なのは、リサイズには
  popover からの drag handoff が存在せず、capture を避ける理由がないため。左/上辺は
  反対辺アンカーで width / height と x / y を同時更新する (位置は store の move() 経由)。
  min / max サイズの SSOT は root の Tailwind class (CSS) で、JS は pointerdown 時に
  computed style の px 解決値を写し取ってクランプに使う。CSS と JS でクランプ値が
  ずれると、左/上辺リサイズで CSS だけが勝った瞬間にアンカー辺が滑る。既知の境界例外:
  逆算した x / y が描画時のビューポート射影クランプ (left の `min()` / top の `clamp()`)
  に当たると、アンカーのはずの下端 / 右端が滑りうる (縦はウィンドウ下端が画面下端
  近傍にあるときの最大十数 px、横は右端が画面外遠くにあるときのみで実質不可視)。
  射影まで含めたサイズ再導出は算術の複雑化に見合わないため受容する
- plain `position: fixed` 要素で popover / dialog の top layer には載せない。モーダルや
  menu が常にウィンドウより手前という既存のオーバーレイ順序ポリシー (ArcadeLayer 参照) に従う
- window 内どこかを pointerdown した時点で最前面化する (store の z カウンタ)
- 本文描画は SessionLogMessageBody (terminal preview の全文 popover と共有) に委譲し、
  kind 別の背景だけスクロール面 (container) 側で担う
- 最小サイズ (min-h-16 / min-w-64) は掴み代の確保が目的。総高さ (本文実測 + 自ヘッダ +
  border) はヘッダ差分のぶん常に pin 元 box より高く、1 行メッセージ等で総高さが下限を
  割った場合は min へ丸められてさらに縦に伸びる
</doc>

<script setup lang="ts">
import { TITLEBAR_HEIGHT } from "@gozd/shared";
import { useEventListener } from "@vueuse/core";
import { onMounted, useTemplateRef } from "vue";
import { RepoIcon } from "../repo-icon";
import { deriveResize, type ResizeBounds, type ResizeDirection } from "./pinnedLogResize";
import SessionLogMessageBody from "./SessionLogMessageBody.vue";
import { usePinnedLog, type PinnedLog } from "./usePinnedLog";
import IconLucideX from "~icons/lucide/x";

interface Props {
  log: PinnedLog;
}

const props = defineProps<Props>();
const { close, move, bringToFront, takeHandoff } = usePinnedLog();

/** ドラッグ / 描画クランプ時に画面内へ残すヘッダの掴み代 (px)。 */
const GRAB_MARGIN = 80;

const rootRef = useTemplateRef<HTMLElement>("root");
const headerRef = useTemplateRef<HTMLElement>("header");

// ドラッグ中の pointer と、pointer からウィンドウ原点へのオフセット。ドラッグ中のみ定義。
let dragState: { pointerId: number; offsetX: number; offsetY: number } | undefined;

// 初期サイズは mount 時に一度だけ書く (:style にバインドしない。理由は doc 参照)。
// store の bodyWidth / bodyHeight は本文 (スクロール面) のサイズなので、実測した自ヘッダ高
// と root の border 厚 (offset と client の差。overflow-hidden なので scrollbar は混ざらない)
// を足して border-box の総サイズへ換算する。
onMounted(() => {
  const root = rootRef.value;
  const header = headerRef.value;
  if (root === null || header === null) return;
  const borderX = root.offsetWidth - root.clientWidth;
  const borderY = root.offsetHeight - root.clientHeight;
  root.style.width = `${props.log.bodyWidth + borderX}px`;
  // ヘッダ高は幅確定後に測る (truncate 前提で折り返しはしないが、layout を width 決定後に
  // 揃えておく)。offsetHeight はヘッダ自身の border-b を含む。
  root.style.height = `${props.log.bodyHeight + header.offsetHeight + borderY}px`;
  // popover ヘッダのドラッグから pin された場合はドラッグ中状態で始まり、掴んだままの
  // pointer の pointermove (window listener) が引き続きこのウィンドウを動かす。
  dragState = takeHandoff(props.log.id);
});

// 8 方位の不可視ハンドル。辺は 4px 幅、角は 8px 角。root が overflow-hidden のため
// 全ハンドルを内縁に置く。辺は角の領域 (inset 2 = 8px) を避けて重なりを作らない。
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
// px 解決値を写し取る (max-w-[90vw] 等の相対値もこの時点の px に解決される)。
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
  // 反対辺アンカーの算術は deriveResize (純関数) に委譲。x/y の基準は store の保存座標では
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
    move(props.log.id, x ?? props.log.x, y ?? props.log.y);
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
  // オフセットは store の x/y ではなく実測 rect 基準。描画クランプで押し戻されている
  // 状態から掴んでも、パネルが保存座標側へ跳ねずその場から動き出す。
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
  move(props.log.id, x, y);
});

function endDrag(event: PointerEvent) {
  if (dragState?.pointerId !== event.pointerId) return;
  dragState = undefined;
}

useEventListener(window, "pointerup", endDrag);
useEventListener(window, "pointercancel", endDrag);
</script>

<template>
  <!-- left / top は store の「望んだ位置」を CSS でビューポート内へ射影する。
       上限 (右端 / 下端) はビューポート縮小で変わるため CSS 側でクランプし、
       下限のうち left 側だけは自要素幅に依存する (幅 - GRAB_MARGIN まではみ出し可) ため
       CSS では書けず、ドラッグ時の JS クランプに委ねる。top の下限はタイトルバー
       (アプリの drag 領域) 直下。 -->
  <section
    ref="root"
    class="fixed flex max-h-[80vh] min-h-16 max-w-[90vw] min-w-64 flex-col overflow-hidden rounded-md border border-border-strong bg-background shadow-xl"
    :style="{
      left: `min(${log.x}px, calc(100vw - ${GRAB_MARGIN}px))`,
      top: `clamp(var(--titlebar-height), ${log.y}px, calc(100vh - ${GRAB_MARGIN}px))`,
      zIndex: log.z,
    }"
    @pointerdown="bringToFront(log.id)"
  >
    <!-- TerminalLeafTitle と同じ 2 段構成 (上段: repo アイコン + repo 名 / 下段: session
         タイトル)。repo 未解決 (空文字) は上段ごと省く。ヘッダ全体がドラッグハンドル。 -->
    <header
      ref="header"
      class="flex shrink-0 cursor-grab items-start gap-2 border-b border-border bg-panel px-2 py-1 select-none active:cursor-grabbing"
      @pointerdown="onHeaderPointerDown"
    >
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div v-if="log.repoName !== ''" class="flex items-center gap-2">
          <RepoIcon :name="log.repoName" :owner="log.repoOwner" />
          <span class="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide">
            {{ log.repoName }}
          </span>
        </div>
        <h2 class="truncate text-xs text-foreground-low" :title="log.title">
          {{ log.title }}
        </h2>
      </div>
      <!-- pointerdown.stop でヘッダのドラッグ開始に食われないようにする -->
      <button
        type="button"
        aria-label="Close"
        class="grid size-5 shrink-0 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
        @pointerdown.stop
        @click="close(log.id)"
      >
        <IconLucideX class="size-3.5" />
      </button>
    </header>

    <div
      class="min-h-0 flex-1 overflow-auto select-text"
      :class="log.kind === 'assistant' ? 'bg-chat-incoming' : 'bg-chat-outgoing'"
    >
      <SessionLogMessageBody :kind="log.kind" :text="log.text" />
    </div>

    <!-- 8 方位の不可視リサイズハンドル。DOM 末尾に置きヘッダ / 本文より手前で pointer を
         受ける。root の pointerdown (bringToFront) はバブリングでそのまま効かせる -->
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
