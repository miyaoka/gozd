<doc lang="md">
ウィンドウ上端のカスタムタイトルバー。main が `titleBarStyle: "hiddenInset"` でネイティブ
バーの描画を消しているため、ドラッグ領域とタイトル表示を renderer が担う。

## 設計判断

- 帯全体を `-webkit-app-region: drag` にする。macOS の信号機ボタンは web コンテンツの
  上に合成される浮いた部品なので、左端に逃げ幅（pad）だけ確保すれば背景は帯の色が
  そのまま透ける
- 非 stable channel では帯を channel-dev-subtle で塗り channel チップ（"dev" =
  `pnpm dev` 起動 / "local" = 無指定 build:app の packaged）を出す。mise 配布の
  stable との取り違え防止が目的
- fullscreen では macOS が信号機ボタンを消すため、main からの `windowFullscreenChange`
  push を受けて pad を畳む。pull hydrate は持たない（fullscreen 中の renderer リロードで
  ずれても pad が残るだけで、次の遷移で自己回復する）
- タイトルは絶対配置でウィンドウ中央に置く。flex 中央だと左の pad / チップの幅で
  視覚中心がずれ、ドラッグでウィンドウを動かすたびに目線が揺れる
</doc>

<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { onMessage } from "../../shared/rpc";
import { useEventLogStore } from "../event-log";
import { useServerStore } from "../server";
import { channelChipLabel } from "./channel";
import { useTitleContext } from "./useTitleContext";
import IconLucideActivity from "~icons/lucide/activity";
import IconLucideServer from "~icons/lucide/server";

/** main の enter/leave-full-screen から届く push。payload 型は購読側が SSOT（docs/rpc.md） */
interface WindowFullscreenChangePayload {
  isFullscreen: boolean;
}

const channelChip = channelChipLabel();
const title = useTitleContext();
const serverStore = useServerStore();
const eventLogStore = useEventLogStore();

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
    :class="channelChip === undefined ? 'bg-panel' : 'bg-channel-dev-subtle'"
  >
    <!-- 信号機ボタンの逃げ幅（x:16 + ボタン 3 個分）。fullscreen ではボタンが消えるので畳む -->
    <div v-if="!isFullscreen" class="_titlebar-traffic-light-pad shrink-0"></div>
    <span
      v-if="channelChip !== undefined"
      class="ml-4 rounded-sm bg-channel-dev px-1.5 py-0.5 text-xs font-semibold text-channel-dev-foreground"
    >
      {{ channelChip }}
    </span>
    <span
      class="pointer-events-none absolute inset-x-0 truncate px-32 text-center text-xs text-foreground-low"
    >
      {{ title === "" ? "gozd" : title }}
    </span>

    <!-- ツールバー右端のグローバルトグル (Swift 期は native titlebar の ToolbarItem。Electron shell は
         native toolbar を持たないためこのカスタム titlebar 右端に集約する)。drag 帯なので no-drag 指定必須。 -->
    <div class="_titlebar-actions ml-auto flex shrink-0 items-center gap-0.5 pr-2">
      <button
        type="button"
        class="grid size-6 place-items-center rounded-sm hover:bg-element-hover"
        :class="
          serverStore.isOpen ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
        "
        title="Running servers"
        aria-label="Running servers"
        @click="serverStore.toggle()"
      >
        <IconLucideServer class="size-3.5" />
      </button>
      <button
        type="button"
        class="grid size-6 place-items-center rounded-sm hover:bg-element-hover"
        :class="
          eventLogStore.isOpen ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
        "
        title="Event log"
        aria-label="Event log"
        @click="eventLogStore.toggle()"
      >
        <IconLucideActivity class="size-3.5" />
      </button>
    </div>
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

/* drag 帯の中でボタンをクリック可能にする (drag region はクリックを飲むため) */
._titlebar-actions {
  -webkit-app-region: no-drag;
}
</style>
