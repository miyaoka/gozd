<doc lang="md">
pin されたセッションログウィンドウ群を描画する app-scope レイヤー。

App.vue 直下にマウントし、表示中の repo / session / terminal の切り替えと独立して
ウィンドウを生存させる (state は `usePinnedLog` の module singleton)。個々のウィンドウの
ドラッグ / リサイズ / close は PinnedLogWindow に閉じる。
</doc>

<script setup lang="ts">
import PinnedLogWindow from "./PinnedLogWindow.vue";
import { usePinnedLog } from "./usePinnedLog";

const { logs } = usePinnedLog();
</script>

<template>
  <PinnedLogWindow v-for="log in logs" :key="log.id" :log="log" />
</template>
