<doc lang="md">
undock されたコンテンツ 1 件のウィンドウシェル。2 つの presentation を切り替える単一の窓口。

undocked window は 2 段階の生き方をする: まずアプリ画面内の in-app パネル (FloatingWindow)、
ヘッダの promote ボタンで別 OS ウィンドウ (ChildWindow) へ昇格。昇格は一方向で、in-app へ
戻す経路は持たない。どちらで描かれているかの SSOT は store の `FloatingWindowState.child` で、
このシェルはそれを見て presentation を選ぶだけ。

consumer (session-log / preview) が差し込むのは中身と close / save のポリシーだけで、
「どちらの presentation か」「昇格の rect 換算」「ヘッダ枠の見た目」はここに閉じる。
両 presentation で `header` / `actions` slot の合成位置を揃えるため、ChildWindow 側の
ヘッダ枠 (border / bg / padding) も FloatingWindow のヘッダと同じ指定をここで持つ。

## presentation ごとに変わる契約

- 移動 / リサイズ / 前面順: in-app は FloatingWindow (ドラッグ + 8 方位ハンドル + ビューポート
  クランプ)、昇格後は OS ネイティブ。よって `move` / `activate` emit は in-app 中だけ発火する
- close は 2 つの emit に分ける。`closeRequested` は「閉じたい要求」で、consumer がガード
  (dirty 確認等) を通してから state を消す: in-app のシェル close ボタンと
  `closeRequestEpoch` の増加 (cmd+w の `floatingWindow.closeFront`)、昇格後は `blockClose` が
  veto したネイティブ close がここに来る。`closed` は「OS ウィンドウがもう閉じた」通知で、
  consumer は無条件に state を消す (ガードを掛けてはいけない — 既に無いウィンドウに確認
  ダイアログを出すと、昇格後はダイアログの居場所である child document ごと消えているため
  応答不能な entry が残る)
- save: cmd+s は `childWindowFocused` context key を持つ昇格後だけ配線される (in-app パネルは
  OS フォーカスを持たないため。in-app 中の保存は consumer の UI ボタン)
- drag handoff: undock 元ヘッダのドラッグからの引き継ぎは in-app パネルにだけ渡す。昇格は
  ボタン操作で pointer を掴んでいないため handoff の概念がない

## 昇格の瞬間

in-app パネルを unmount して OS ウィンドウを mount する即差し替えで、両者が同時に mount
されている時間は作らない。OS ウィンドウの表示 (show=no → ready-to-show) までの実測 ~50ms は
何も表示されない隙間になるが、昇格はボタン操作で位置も変わらないため追従の破綻がなく、
ゴーストで埋める必要がない (ドラッグ追従中にウィンドウを生成する経路だけがこのラグを
問題にする)。同時 mount を避けることは preview では必須で、Monaco が document ごとの
instance を window registry へ登録するため、二重に生かすと registry と入力経路が二重になる。
</doc>

<script setup lang="ts">
import ChildWindow from "./ChildWindow.vue";
import type { ChildWindowInit } from "./childWindowInit";
import FloatingWindow from "./FloatingWindow.vue";
import type { UndockDragHandoff } from "./undockDrag";

interface Props {
  /** in-app パネルの位置 / 前面順 / 初期本文サイズ (FloatingWindowState の対応フィールド)。 */
  x: number;
  y: number;
  z: number;
  bodyWidth: number;
  bodyHeight: number;
  /** 外部からの close 要求 epoch (FloatingWindowState.closeRequestEpoch)。 */
  closeRequestEpoch: number;
  /** 昇格済みなら child window の生成パラメータ (FloatingWindowState.child)。 */
  child?: ChildWindowInit;
  /** 昇格後の OS ウィンドウのタイトルバー表示 (document.title)。 */
  title: string;
  /** 昇格後のネイティブ close を veto するか (dirty ガード)。in-app では close ボタンの
   * emit を consumer がガードするため使われない。 */
  blockClose: boolean;
  /** undock 元から引き継いだドラッグ (in-app パネルにだけ渡す。doc 参照)。 */
  handoff?: UndockDragHandoff;
}

defineProps<Props>();

const emit = defineEmits<{
  /** in-app パネルの移動 (ドラッグ / 左上辺リサイズ)。昇格後は OS が SSOT のため発火しない。 */
  move: [x: number, y: number];
  /** in-app パネルの前面化要求。昇格後は発火しない。 */
  activate: [];
  /** 別 OS ウィンドウへの昇格要求 (実測コンテンツ rect のスクリーン座標換算)。 */
  promote: [init: ChildWindowInit];
  /** 閉じたい要求。consumer がガードを通してから state を消す (doc 参照)。 */
  closeRequested: [];
  /** OS ウィンドウが既に閉じた。consumer は無条件に state を消す (doc 参照)。 */
  closed: [];
  /** cmd+s (childWindow.save) の要求。昇格後のみ発火する。 */
  saveRequested: [];
}>();
</script>

<template>
  <FloatingWindow
    v-if="child === undefined"
    :x="x"
    :y="y"
    :z="z"
    :body-width="bodyWidth"
    :body-height="bodyHeight"
    :close-request-epoch="closeRequestEpoch"
    :handoff="handoff"
    @move="(nextX, nextY) => emit('move', nextX, nextY)"
    @activate="emit('activate')"
    @promote="emit('promote', $event)"
    @close="emit('closeRequested')"
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
    @close="emit('closed')"
    @close-requested="emit('closeRequested')"
    @save-requested="emit('saveRequested')"
  >
    <!-- OS ウィンドウ全面を占めるルート。テキスト / 背景の既定は複製 CSS の Tier 3 でも
         当たるが、ルートで明示して child 側の描画を自立させる -->
    <div class="flex h-screen flex-col bg-background text-foreground">
      <!-- ヘッダ枠は FloatingWindow のヘッダと同じ指定 (doc 参照)。close はネイティブ
           titlebar、promote は済んでいるため、シェルのボタンは持たず actions だけ並べる -->
      <header class="flex shrink-0 items-start gap-2 border-b border-border bg-panel px-2 py-1">
        <slot name="header" />
        <div class="flex shrink-0 items-center gap-1">
          <slot name="actions" />
        </div>
      </header>

      <slot />
    </div>
  </ChildWindow>
</template>
