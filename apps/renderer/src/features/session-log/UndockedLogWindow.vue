<doc lang="md">
undock されたセッションログメッセージ 1 件のウィンドウ。

ウィンドウの実体 (in-app パネル / 昇格後の OS ウィンドウ、その切り替えと昇格の rect 換算) は
汎用シェル UndockedWindow に委譲し、ここはヘッダ内容 (TerminalLeafTitle と同じ repo + session
タイトルの 2 段構成) と kind 別配色の本文だけを担う。ヘッダ / 本文は両 presentation から同じ
ものを描くため UndockedLogHeader / UndockedLogBody に切り出している。

内容は undock 時点の凍結スナップショットで dirty 状態を持たないため、close はガードなし
(`blockClose` 常時 false で、closeRequested / closed のどちらも即 state 削除)。cmd+s は保存
対象が無いので配線しない。タイトルバー (document.title) は session タイトル。OS ウィンドウの
生成に失敗した場合は ChildWindow が (toast 通知の上で) close を emit するため entry ごと消える。
</doc>

<script setup lang="ts">
import { UndockedWindow } from "../floating-window";
import UndockedLogBody from "./UndockedLogBody.vue";
import UndockedLogHeader from "./UndockedLogHeader.vue";
import { useUndockedLog, type UndockedLog } from "./useUndockedLog";

interface Props {
  log: UndockedLog;
}

const props = defineProps<Props>();
const { close, move, bringToFront, takeHandoff, promote } = useUndockedLog();

// popover ヘッダのドラッグから undock された場合の引き継ぎ。setup で 1 回だけ消費する
// (undock() → 描画フラッシュ → setup が同期で完結するため、setup 時点で必ず取得できる)。
const handoff = takeHandoff(props.log.id);
</script>

<template>
  <UndockedWindow
    :x="log.x"
    :y="log.y"
    :z="log.z"
    :body-width="log.bodyWidth"
    :body-height="log.bodyHeight"
    :close-request-epoch="log.closeRequestEpoch"
    :child="log.child"
    :title="log.title"
    :block-close="false"
    :handoff="handoff"
    @move="(x, y) => move(log.id, x, y)"
    @activate="bringToFront(log.id)"
    @promote="promote(log.id, $event)"
    @close-requested="close(log.id)"
    @closed="close(log.id)"
  >
    <template #header>
      <UndockedLogHeader :log="log" />
    </template>

    <UndockedLogBody :log="log" />
  </UndockedWindow>
</template>
