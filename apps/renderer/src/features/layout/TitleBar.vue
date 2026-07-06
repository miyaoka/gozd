<doc lang="md">
ウィンドウ上端のカスタムタイトルバー。main が `titleBarStyle: "hiddenInset"` でネイティブ
バーの描画を消しているため、ドラッグ領域とタイトル表示を renderer が担う。

## 設計判断

- 帯全体を `-webkit-app-region: drag` にする。macOS の信号機ボタンは web コンテンツの
  上に合成される浮いた部品なので、左端に逃げ幅（pad）だけ確保すれば背景は帯の色が
  そのまま透ける
- dev channel（`pnpm dev` 起動）では帯を channel-dev-subtle で塗り "dev" チップを出す。
  packaged (stable) との取り違え防止が目的
- タイトルは絶対配置でウィンドウ中央に置く。flex 中央だと左の pad / チップの幅で
  視覚中心がずれ、ドラッグでウィンドウを動かすたびに目線が揺れる
</doc>

<script setup lang="ts">
import { isDevChannel } from "./channel";
import { useTitleContext } from "./useTitleContext";

const isDev = isDevChannel();
const title = useTitleContext();
</script>

<template>
  <div
    class="_titlebar relative flex shrink-0 items-center border-b border-border-subtle"
    :class="isDev ? 'bg-channel-dev-subtle' : 'bg-panel'"
  >
    <!-- 信号機ボタンの逃げ幅（x:16 + ボタン 3 個分） -->
    <div class="_titlebar-traffic-light-pad shrink-0"></div>
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
