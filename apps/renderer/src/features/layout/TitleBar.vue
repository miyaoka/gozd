<script setup lang="ts">
import type { WindowFullscreenChangePayload } from "@gozd/rpc";
import { onUnmounted, ref } from "vue";
import { onMessage } from "../../shared/rpc";
import { useEventLogStore } from "../event-log";
import { useMyWorkStore } from "../my-work";
import { useServerStore } from "../server";
import { channelChipLabel } from "./channel";
import DayProgressBar from "./DayProgressBar.vue";
import { useNotificationCenterStore } from "./useNotificationCenterStore";
import IconLucideActivity from "~icons/lucide/activity";
import IconLucideBell from "~icons/lucide/bell";
import IconLucideInbox from "~icons/lucide/inbox";
import IconLucideServer from "~icons/lucide/server";

const channelChip = channelChipLabel();
const serverStore = useServerStore();
const eventLogStore = useEventLogStore();
const myWorkStore = useMyWorkStore();
const notificationCenterStore = useNotificationCenterStore();

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
    <!-- 中央の 1 日進捗バー。ウィンドウ幅に追従させず上限で頭打ちにする（横に伸ばしても
         読み取れる情報は増えず、広い画面では帯を横断する巨大な線になるだけ）。
         px は左の信号機 pad + channel チップ / 右のトグル群と重ならないための逃げ幅。
         最小幅では上限に届かずバー側が縮むので、チップに寄る前に頭打ちが解ける -->
    <div class="pointer-events-none absolute inset-x-0 flex justify-center px-40">
      <div class="w-full max-w-md">
        <DayProgressBar />
      </div>
    </div>

    <!-- ツールバー右端のグローバルトグル (native toolbar を持たないためこのカスタム titlebar 右端に
         集約する)。drag 帯なので no-drag 指定必須。 -->
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
          myWorkStore.isOpen ? 'text-primary-text' : 'text-foreground-low hover:text-foreground'
        "
        title="My work"
        aria-label="My work"
        @click="myWorkStore.toggle()"
      >
        <IconLucideInbox class="size-3.5" />
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
      <button
        type="button"
        class="relative grid size-6 place-items-center rounded-sm hover:bg-element-hover"
        :class="
          notificationCenterStore.isOpen
            ? 'text-primary-text'
            : 'text-foreground-low hover:text-foreground'
        "
        title="Notifications"
        aria-label="Notifications"
        @click="notificationCenterStore.toggle()"
      >
        <IconLucideBell class="size-3.5" />
        <!-- 未読ドット。未読に error を含むときだけ destructive で目立たせる -->
        <span
          v-if="notificationCenterStore.unseenCount > 0"
          class="absolute top-0.5 right-0.5 size-1.5 rounded-full"
          :class="notificationCenterStore.hasUnseenError ? 'bg-destructive' : 'bg-primary'"
        ></span>
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
