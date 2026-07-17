<doc lang="md">
undock されたセッションログウィンドウ群を描画する app-scope レイヤー。

App.vue 直下にマウントし、表示中の repo / session / terminal の切り替えと独立して
ウィンドウを生存させる (state は `useUndockedLog` の module singleton)。個々のウィンドウの
ドラッグ / リサイズ / close は UndockedLogWindow に閉じる。
</doc>

<script setup lang="ts">
import UndockedLogWindow from "./UndockedLogWindow.vue";
import { useUndockedLog } from "./useUndockedLog";

const { logs } = useUndockedLog();
</script>

<template>
  <UndockedLogWindow v-for="log in logs" :key="log.id" :log="log" />
</template>
