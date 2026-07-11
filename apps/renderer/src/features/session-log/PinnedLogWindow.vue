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
- 初期サイズは pin 元 popover の実測 rect (store の width / height)。`:style` には
  バインドせず mount 時に一度だけ inline style へ書く。Vue の style patch はバインド
  オブジェクトの全キーを毎パッチ再適用するため、バインドするとドラッグ (left / top
  更新) のたびに width / height が初期値で再セットされ、native resize (`resize: both`)
  が書いた値を巻き戻してしまう。mount 後のサイズ SSOT はブラウザが書く inline
  width/height で、Vue は以後このプロパティに触らない
- plain `position: fixed` 要素で popover / dialog の top layer には載せない。モーダルや
  menu が常にウィンドウより手前という既存のオーバーレイ順序ポリシー (ArcadeLayer 参照) に従う
- window 内どこかを pointerdown した時点で最前面化する (store の z カウンタ)
- 本文描画は SessionLogMessageBody (terminal preview の全文 popover と共有) に委譲し、
  kind 別の背景だけスクロール面 (container) 側で担う
- 最小サイズ (min-h-16 / min-w-64) は掴み代の確保が目的。短いメッセージの pin では
  popover 実測高が下限を上回ることが多いが、1 行メッセージ等で下限に丸められた場合は
  その分だけ pin 元より縦に伸びる
</doc>

<script setup lang="ts">
import { TITLEBAR_HEIGHT } from "@gozd/shared";
import { useEventListener } from "@vueuse/core";
import { onMounted, useTemplateRef } from "vue";
import { RepoIcon } from "../repo-icon";
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

// ドラッグ中の pointer と、pointer からウィンドウ原点へのオフセット。ドラッグ中のみ定義。
let dragState: { pointerId: number; offsetX: number; offsetY: number } | undefined;

// 初期サイズは mount 時に一度だけ書く (:style にバインドしない)。Vue の style patch は
// バインドした全キーを毎パッチ再適用するため、バインドするとドラッグのたびに native
// resize の結果が初期値へ巻き戻る。ここで書いた後のサイズ SSOT は DOM の inline style。
onMounted(() => {
  const root = rootRef.value;
  if (root === null) return;
  root.style.width = `${props.log.width}px`;
  root.style.height = `${props.log.height}px`;
  // popover ヘッダのドラッグから pin された場合はドラッグ中状態で始まり、掴んだままの
  // pointer の pointermove (window listener) が引き続きこのウィンドウを動かす。
  dragState = takeHandoff(props.log.id);
});

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
    class="fixed flex max-h-[80vh] min-h-16 max-w-[90vw] min-w-64 resize flex-col overflow-hidden rounded-md border border-border-strong bg-background shadow-xl"
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
  </section>
</template>
