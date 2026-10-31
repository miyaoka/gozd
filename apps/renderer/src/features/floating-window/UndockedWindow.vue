<script setup lang="ts">
import ChildWindow from "./ChildWindow.vue";
import type { ChildWindowInit } from "./childWindowInit";
import FloatingWindow from "./FloatingWindow.vue";
import UndockedWindowHeader from "./UndockedWindowHeader.vue";
import type { UndockDragHandoff } from "./useFloatingWindows";

interface Props {
  /** in-app パネルの位置 / 初期中身サイズ (FloatingWindowState の対応フィールド)。 */
  x: number;
  y: number;
  contentWidth: number;
  contentHeight: number;
  /** 昇格済みなら child window の生成パラメータ (FloatingWindowState.child)。 */
  child?: ChildWindowInit;
  /** 昇格後の OS ウィンドウのタイトルバー表示 (document.title)。 */
  title: string;
  /** 昇格後のネイティブ close を veto するか (dirty ガード)。in-app では close 要求を
   * consumer がガードするため使われない。 */
  blockClose: boolean;
  /** undock 元から引き継いだドラッグ (in-app パネルにだけ渡す)。 */
  handoff?: UndockDragHandoff;
}

defineProps<Props>();

const emit = defineEmits<{
  /** in-app パネルの移動 (ドラッグ / 左上辺リサイズ)。昇格後は OS が SSOT のため発火しない。 */
  move: [x: number, y: number];
  /** 別 OS ウィンドウへの昇格要求 (実測コンテンツ rect のスクリーン座標換算)。 */
  promote: [init: ChildWindowInit];
  /** 昇格の失敗 (OS ウィンドウを開けなかった)。consumer は entry を消さず demote して引き返す
   * (消すと preview の移動済みの未保存 draft が失われる)。 */
  promoteFailed: [];
  /** 閉じたい要求。consumer がガードを通してから state を消す。 */
  closeRequested: [];
  /** OS ウィンドウが既に閉じた。consumer は無条件に state を消す。 */
  closed: [];
  /** Cmd+S の要求。保存の可否・実処理は consumer の知識。 */
  saveRequested: [];
}>();
</script>

<template>
  <FloatingWindow
    v-if="child === undefined"
    :x="x"
    :y="y"
    :content-width="contentWidth"
    :content-height="contentHeight"
    :handoff="handoff"
    @move="(nextX, nextY) => emit('move', nextX, nextY)"
    @promote="emit('promote', $event)"
    @close-requested="emit('closeRequested')"
    @save-requested="emit('saveRequested')"
  >
    <template #header>
      <slot name="header" />
    </template>
    <template #actions>
      <slot name="actions" />
    </template>

    <slot />
  </FloatingWindow>

  <ChildWindow
    v-else
    :title="title"
    :screen-x="child.screenX"
    :screen-y="child.screenY"
    :width="child.width"
    :height="child.height"
    :block-close="blockClose"
    @open-failed="emit('promoteFailed')"
    @close="emit('closed')"
    @close-requested="emit('closeRequested')"
    @save-requested="emit('saveRequested')"
  >
    <!-- OS ウィンドウ全面を占めるルート。テキスト / 背景の既定は複製 CSS の Tier 3 でも
         当たるが、ルートで明示して child 側の描画を自立させる -->
    <div class="flex h-screen flex-col bg-background text-foreground">
      <!-- close はネイティブ titlebar、promote は済んでいるため、シェルのボタン (trailing) は
           持たず中身固有の actions だけ並べる -->
      <UndockedWindowHeader>
        <template #header>
          <slot name="header" />
        </template>
        <template #actions>
          <slot name="actions" />
        </template>
      </UndockedWindowHeader>

      <slot />
    </div>
  </ChildWindow>
</template>
