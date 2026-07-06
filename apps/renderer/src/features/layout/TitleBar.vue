<doc lang="md">
ウィンドウ上端のカスタムタイトルバー。main が `titleBarStyle: "hiddenInset"` でネイティブ
バーの描画を消しているため、ドラッグ領域とタイトル表示を renderer が担う。

## 設計判断

- 帯全体を `-webkit-app-region: drag` にする。macOS の信号機ボタンは web コンテンツの
  上に合成される浮いた部品なので、左端に逃げ幅（pad）だけ確保すれば背景は帯の色が
  そのまま透ける
- dev channel（`pnpm dev` 起動）では帯を channel-dev-subtle で塗り "dev" チップを出す。
  packaged (stable) との取り違え防止が目的
- fullscreen では macOS が信号機ボタンを消すため、main からの `windowFullscreenChange`
  push を受けて pad を畳む。pull hydrate は持たない（fullscreen 中の renderer リロードで
  ずれても pad が残るだけで、次の遷移で自己回復する）
- タイトルは絶対配置でウィンドウ中央に置く。flex 中央だと左の pad / チップの幅で
  視覚中心がずれ、ドラッグでウィンドウを動かすたびに目線が揺れる
</doc>

<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { onMessage } from "../../shared/rpc";
import { isDevChannel } from "./channel";
import { useTitleContext } from "./useTitleContext";

/** main の enter/leave-full-screen から届く push。payload 型は購読側が SSOT（docs/rpc.md） */
interface WindowFullscreenChangePayload {
  isFullscreen: boolean;
}

const isDev = isDevChannel();
const title = useTitleContext();

// fullscreen では macOS が信号機ボタンを消すため pad を畳む。初期値 false は
// 「ウィンドウは非 fullscreen で生成される」前提。pull hydrate は持たない
// （renderer リロードでずれても pad が残るだけで、次の遷移で自己回復する）
const isFullscreen = ref(false);
const disposeFullscreen = onMessage<WindowFullscreenChangePayload>(
  "windowFullscreenChange",
  (payload) => {
    isFullscreen.value = payload.isFullscreen;
  },
);
onUnmounted(disposeFullscreen);
</script>

<template>
  <div
    class="_titlebar relative flex shrink-0 items-center border-b border-border-subtle"
    :class="isDev ? 'bg-channel-dev-subtle' : 'bg-panel'"
  >
    <!-- 信号機ボタンの逃げ幅（x:16 + ボタン 3 個分）。fullscreen ではボタンが消えるので畳む -->
    <div v-if="!isFullscreen" class="_titlebar-traffic-light-pad shrink-0"></div>
    <span
      v-if="isDev"
      class="ml-4 rounded-sm bg-channel-dev px-1.5 py-0.5 text-xs font-semibold text-channel-dev-foreground"
    >
      dev
    </span>
    <span
      class="pointer-events-none absolute inset-x-0 truncate px-32 text-center text-xs text-foreground-low"
    >
      {{ title === "" ? "gozd" : title }}
    </span>
  </div>
</template>

<style>
._titlebar {
  height: var(--titlebar-height);
  -webkit-app-region: drag;
}

._titlebar-traffic-light-pad {
  width: 80px;
}
</style>
