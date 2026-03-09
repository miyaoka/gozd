<doc lang="md">
アプリ全体のレイアウトを構成するコンテナ。

## 構成

- 水平方向: SidebarPane → FilerPane → PreviewPane → TerminalPane（各ペイン間にリサイズハンドル）
- 垂直方向: メインエリア → DebugPane（リサイズハンドル）

## リサイズ

各ハンドルは隣接する左右（上下）のペインだけを連動してリサイズする。
ハンドルより遠いペインには影響しない。
</doc>

<script setup lang="ts">
import { useWindowSize } from "@vueuse/core";
import { ref, watchEffect } from "vue";
import DebugPane from "../debug/DebugPane.vue";
import DiagnosticsPane from "../diagnostics/DiagnosticsPane.vue";
import FilerPane from "../filer/FilerPane.vue";
import PreviewPane from "../preview/PreviewPane.vue";
import TerminalPane from "../terminal/TerminalPane.vue";
import ResizeHandle from "./ResizeHandle.vue";
import SidebarPane from "./SidebarPane.vue";

const SIDEBAR_MIN_WIDTH = 120;
const FILER_MIN_WIDTH = 160;
const PREVIEW_MIN_WIDTH = 200;
const TERMINAL_MIN_WIDTH = 200;
const DEBUG_MIN_HEIGHT = 40;
const MAIN_MIN_HEIGHT = 200;

/** ハンドル幅 w-2 = 8px */
const HANDLE_WIDTH = 8;
const HANDLE_COUNT = 3;

const sidebarWidth = ref(224);
const filerWidth = ref(256);
const previewWidth = ref(400);
const terminalWidth = ref(400);
const mainHeight = ref(600);
const debugHeight = ref(128);

// ウィンドウサイズからターミナルとメインの初期値を算出
const { width: windowWidth, height: windowHeight } = useWindowSize();

watchEffect(() => {
  const usedWidth =
    sidebarWidth.value + filerWidth.value + previewWidth.value + HANDLE_WIDTH * HANDLE_COUNT;
  terminalWidth.value = Math.max(TERMINAL_MIN_WIDTH, windowWidth.value - usedWidth);
});

watchEffect(() => {
  const usedHeight = debugHeight.value + HANDLE_WIDTH;
  mainHeight.value = Math.max(MAIN_MIN_HEIGHT, windowHeight.value - usedHeight);
});
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-zinc-900 text-white">
    <div class="flex shrink-0 overflow-hidden" :style="{ height: `${mainHeight}px` }">
      <div class="shrink-0 overflow-hidden" :style="{ width: `${sidebarWidth}px` }">
        <SidebarPane />
      </div>
      <ResizeHandle
        v-model:before-size="sidebarWidth"
        v-model:after-size="filerWidth"
        direction="horizontal"
        :before-min-size="SIDEBAR_MIN_WIDTH"
        :after-min-size="FILER_MIN_WIDTH"
      />

      <div class="shrink-0 overflow-hidden" :style="{ width: `${filerWidth}px` }">
        <FilerPane />
      </div>
      <ResizeHandle
        v-model:before-size="filerWidth"
        v-model:after-size="previewWidth"
        direction="horizontal"
        :before-min-size="FILER_MIN_WIDTH"
        :after-min-size="PREVIEW_MIN_WIDTH"
      />

      <div class="shrink-0 overflow-hidden" :style="{ width: `${previewWidth}px` }">
        <PreviewPane />
      </div>
      <ResizeHandle
        v-model:before-size="previewWidth"
        v-model:after-size="terminalWidth"
        direction="horizontal"
        :before-min-size="PREVIEW_MIN_WIDTH"
        :after-min-size="TERMINAL_MIN_WIDTH"
      />

      <div class="shrink-0 overflow-hidden p-2" :style="{ width: `${terminalWidth}px` }">
        <TerminalPane />
      </div>
    </div>

    <ResizeHandle
      v-model:before-size="mainHeight"
      v-model:after-size="debugHeight"
      direction="vertical"
      :before-min-size="MAIN_MIN_HEIGHT"
      :after-min-size="DEBUG_MIN_HEIGHT"
    />
    <div class="flex shrink-0 gap-2 overflow-hidden p-0" :style="{ height: `${debugHeight}px` }">
      <div class="w-1/2 overflow-hidden">
        <DebugPane />
      </div>
      <div class="w-1/2 overflow-hidden">
        <DiagnosticsPane />
      </div>
    </div>
  </div>
</template>
