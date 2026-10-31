<script setup lang="ts">
import type { GitMyWorkAxisKey } from "@gozd/rpc";
import { GIT_MY_WORK_AXIS_KEYS } from "@gozd/rpc";
import { useIntervalFn, useWindowFocus } from "@vueuse/core";
import { computed, useTemplateRef, watch } from "vue";
import { useSurface } from "../../shared/surface";
import { activateExternalLink, ITEM_KIND_DISPLAY } from "../github-item";
import MyWorkSection from "./MyWorkSection.vue";
import { MY_WORK_FRESH_MS, useMyWorkStore } from "./useMyWorkStore";
import IconLucideInbox from "~icons/lucide/inbox";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";
import IconLucideTriangleAlert from "~icons/lucide/triangle-alert";
import IconLucideX from "~icons/lucide/x";

const myWorkStore = useMyWorkStore();
const focused = useWindowFocus();

/** 取得対象であるか。開いていて focus 中のときだけ true。 */
const isPollTarget = computed(() => myWorkStore.isOpen && focused.value);

// 対象の出入り（パネル開閉 / focus 復帰・喪失）で取得。lock 中はキャッシュのまま no-op。
watch(isPollTarget, (target) => {
  if (target) myWorkStore.fetchIfDue();
});

// 開いている間の定期取得。対象外のときは撃たない。
useIntervalFn(
  () => {
    if (isPollTarget.value) myWorkStore.fetchIfDue();
  },
  MY_WORK_FRESH_MS,
  { immediateCallback: false },
);

/**
 * 軸キー → ペインの見出しラベル。Record で鍵付けするため、軸の増減はここが compile error で
 * 追従を要求する。
 */
const AXIS_TITLES: Record<GitMyWorkAxisKey, string> = {
  authoredIssues: "My issues",
  authoredPrs: "My pull requests",
  mentioned: "Mentioned",
  reviewRequestedPrs: "Review requested",
};

/**
 * ペインと失敗表示のリンクはどちらもこれを回す。軸の集合と並びは `GIT_MY_WORK_AXIS_KEYS` から
 * 導出し、ここはラベルを与えるだけ。並びは、自分が作ったもの（issue → PR）→ 自分に
 * 向けられたもの（メンション → レビュー依頼）。issue → PR の順は GitHub web の種別並び
 * （Issues / Pull requests）に合わせる。
 */
const AXES = computed(() =>
  GIT_MY_WORK_AXIS_KEYS.map((key) => ({
    key,
    title: AXIS_TITLES[key],
    group: myWorkStore.groups[key],
  })),
);

/**
 * 一覧を出せないときに残す GitHub への導線。URL は取得の成否に依存しないが、main から
 * 一度も応答が届いていなければ手元に無い（webLinks が空）ので、その軸は出さない
 * （描けないものを描かない）。混在軸はリンクが種別ごとに分かれるため、軸名に種別を添える。
 */
const failureLinks = computed(() =>
  AXES.value.flatMap((axis) => {
    const webLinks = axis.group.webLinks;
    return webLinks.map((link) => ({
      label:
        webLinks.length === 1
          ? axis.title
          : `${axis.title} (${ITEM_KIND_DISPLAY[link.kind].label})`,
      url: link.url,
    }));
  }),
);

const panelRef = useTemplateRef<HTMLElement>("panel");

const { raise } = useSurface(panelRef, {
  isOpen: () => myWorkStore.isOpen,
  requestClose: () => myWorkStore.close(),
});
</script>

<template>
  <div
    ref="panel"
    popover="manual"
    tabindex="-1"
    class="_my-work-popover w-[min(1440px,100vw)] flex-col border-0 border-l border-border bg-panel p-0 shadow-xl outline-hidden [&:popover-open]:flex"
    @pointerdown.capture="raise()"
  >
    <header class="flex items-center gap-2 border-b border-border px-3 py-2">
      <IconLucideInbox class="size-4 text-foreground-low" />
      <h2 class="text-sm font-medium text-foreground">My work</h2>
      <!-- キャッシュを出しつつ直近の取得が失敗している状態。トーストは消えるのでここに残す -->
      <span
        v-if="myWorkStore.hasLoaded && myWorkStore.lastError !== undefined"
        class="flex min-w-0 flex-1 items-center gap-1 text-xs text-warning-text"
        :title="myWorkStore.lastError"
      >
        <IconLucideTriangleAlert class="size-3.5 shrink-0" />
        <span class="truncate">Showing stale data</span>
      </span>
      <span v-else class="flex-1"></span>
      <label
        class="shrink-0 cursor-pointer rounded-sm px-2 py-0.5 text-xs has-focus-visible:ring-2 has-focus-visible:ring-ring"
        :class="
          myWorkStore.unreadOnly
            ? 'bg-primary text-primary-foreground'
            : 'bg-element text-foreground-low hover:text-foreground'
        "
      >
        <input v-model="myWorkStore.unreadOnly" type="checkbox" class="sr-only" />
        Unread only
      </label>
      <button
        type="button"
        aria-label="Refresh"
        title="Refresh"
        :disabled="myWorkStore.isLoading"
        class="grid size-6 place-items-center rounded-sm text-foreground-low not-disabled:hover:bg-element-hover not-disabled:hover:text-foreground disabled:text-foreground-muted"
        @click="myWorkStore.refresh()"
      >
        <IconLucideRefreshCw class="size-3.5" :class="myWorkStore.isLoading && 'animate-spin'" />
      </button>
      <button
        type="button"
        aria-label="Close"
        class="grid size-6 place-items-center rounded-sm text-foreground-low hover:bg-element-hover hover:text-foreground"
        @click="myWorkStore.close()"
      >
        <IconLucideX class="size-4" />
      </button>
    </header>

    <!-- 未取得。失敗しているならその理由を出す（進行中でないのに Loading を出さない） -->
    <div
      v-if="!myWorkStore.hasLoaded"
      class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-xs"
    >
      <template v-if="myWorkStore.lastError === undefined">
        <span class="text-foreground-low">Loading…</span>
      </template>
      <template v-else>
        <IconLucideTriangleAlert class="size-6 text-destructive-text" />
        <span class="text-foreground">{{ myWorkStore.lastError }}</span>
        <button
          type="button"
          :disabled="myWorkStore.isLoading"
          class="rounded-sm bg-element px-3 py-1 text-foreground not-disabled:cursor-pointer not-disabled:hover:bg-element-hover disabled:text-foreground-muted"
          @click="myWorkStore.refresh()"
        >
          Retry
        </button>
        <!-- 一覧が出せない間の逃げ道。gh が使えない状態こそ GitHub 側で見たい -->
        <div v-if="failureLinks.length > 0" class="flex flex-wrap justify-center gap-3">
          <a
            v-for="link in failureLinks"
            :key="link.url"
            :href="link.url"
            class="text-primary-text underline"
            @click="activateExternalLink($event, link.url)"
            @auxclick="activateExternalLink($event, link.url)"
          >
            {{ link.label }}
          </a>
        </div>
      </template>
    </div>

    <div v-else class="flex min-h-0 flex-1">
      <MyWorkSection
        v-for="axis in AXES"
        :key="axis.key"
        :title="axis.title"
        :group="axis.group"
        :unread-only="myWorkStore.unreadOnly"
      />
    </div>
  </div>
</template>

<style>
._my-work-popover {
  /* タイトルバー（drag 領域）を覆わないよう、上端をその直下に置き右端に沿わせる */
  inset: unset;
  margin: 0;
  top: var(--titlebar-height);
  right: 0;
  bottom: 0;
  /* UA スタイル [popover] { height: fit-content } を打ち消す。
     height が auto でないと top + bottom の伸縮が効かずコンテンツ高さに縮む */
  height: auto;
  max-height: none;
  /* UA スタイル [popover] { overflow: auto } を打ち消す。スクロールするのは各ペインの
     一覧だけで、パネルそのものは動かない。残すとパネル全体が縦スクロールし、ヘッダーが
     画面外へ流れて Refresh / Close に届かなくなる */
  overflow: hidden;
}
</style>
