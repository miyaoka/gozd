<doc lang="md">
undock されたコンテンツ 1 件のウィンドウシェル。2 つの presentation を切り替える単一の窓口。

undocked window は 2 段階の生き方をする: まずアプリ画面内の in-app パネル (FloatingWindow)、
ヘッダの promote ボタンで別 OS ウィンドウ (ChildWindow) へ昇格。ユーザー操作としては一方向で、
in-app へ戻す経路は持たない (例外は昇格そのものの失敗。後述)。どちらで描かれているかの SSOT は
store の `FloatingWindowState.child` で、このシェルはそれを見て presentation を選ぶだけ。

consumer (session-log / preview) が差し込むのは中身と close / save のポリシーだけで、
「どちらの presentation か」「昇格の rect 換算」は presentation 側に閉じる。ヘッダ枠は
両 presentation 共通の UndockedWindowHeader が持つ。

## presentation ごとに変わる契約

- 移動 / リサイズ: in-app は FloatingWindow (ドラッグ + 8 方位ハンドル + ビューポートクランプ)、
  昇格後は OS ネイティブ。よって `move` emit は in-app 中だけ発火する
- close は 2 つの emit に分ける。`closeRequested` は「閉じたい要求」で、consumer がガード
  (dirty 確認等) を通してから state を消す: in-app のシェル close ボタン・フォーカスがある
  サーフェスを閉じる ESC / Cmd+W (`surface.closeFocused`)、昇格後は `blockClose` が veto した
  ネイティブ close が
  ここに来る。`closed` は「OS ウィンドウがもう閉じた」通知で、consumer は無条件に state を消す
  (ガードを掛けてはいけない — 既に無いウィンドウに確認ダイアログを出すと、昇格後はダイアログの
  居場所である child document ごと消えているため応答不能な entry が残る)
- save: Cmd+S はどちらの presentation でもフォーカスに応じて配線される (in-app は
  `floatingWindowFocused`、昇格後は `childWindowFocused`)
- drag handoff: undock 元ヘッダのドラッグからの引き継ぎは in-app パネルにだけ渡す。昇格は
  ボタン操作で pointer を掴んでいないため handoff の概念がない

## 昇格の瞬間と失敗

in-app パネルを unmount して OS ウィンドウを mount する即差し替えで、両者が同時に mount
されている時間は作らない。OS ウィンドウの表示 (show=no → ready-to-show) までは何も表示され
ない隙間になるが、昇格はボタン操作で位置も変わらないため追従の破綻がなく、ゴーストで埋める
必要がない (ドラッグ追従中にウィンドウを生成する経路だけがこのラグを問題にする)。同時 mount を
避けることは preview では必須で、同一 draft に対して生きた Monaco editor が 2 つ並ぶと入力
経路が二重になり、Monaco のフォーカス判定 (`getActiveDocument`) もどちらの document を見るかで
揺れる。

OS ウィンドウの生成失敗 (`openFailed`) は `promoteFailed` として consumer へ通し、consumer は
store の `demote()` で in-app パネルへ引き返す。entry を消すと preview の「移動済みの未保存
draft」がトースト 1 枚で失われるため、失敗時は昇格前の状態へ戻すのが正しい。
</doc>

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
  /** undock 元から引き継いだドラッグ (in-app パネルにだけ渡す。doc 参照)。 */
  handoff?: UndockDragHandoff;
}

defineProps<Props>();

const emit = defineEmits<{
  /** in-app パネルの移動 (ドラッグ / 左上辺リサイズ)。昇格後は OS が SSOT のため発火しない。 */
  move: [x: number, y: number];
  /** 別 OS ウィンドウへの昇格要求 (実測コンテンツ rect のスクリーン座標換算)。 */
  promote: [init: ChildWindowInit];
  /** 昇格の失敗 (OS ウィンドウを開けなかった)。consumer は demote して引き返す (doc 参照)。 */
  promoteFailed: [];
  /** 閉じたい要求。consumer がガードを通してから state を消す (doc 参照)。 */
  closeRequested: [];
  /** OS ウィンドウが既に閉じた。consumer は無条件に state を消す (doc 参照)。 */
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
