<doc lang="md">
my work パネルの 1 ペイン。描くのは与えられた 1 軸ぶんで、軸の選定と並びは親が決める。

## 設計判断

- 見出しに出す数は **検索条件に一致する総件数**。取得は上限で切られるため、表示件数だけを
  出すと「上限ちょうどで止まっている」のか「たまたま同数」なのかが区別できない
- 切れているときだけ `表示件数 / 総件数` の形にする。切れていないときに常に併記すると、
  同じ数字が 2 つ並ぶだけで読む側の負荷が増える
- GitHub を開く導線は**見出し右端の独立したボタン**にする。上限で切れた残りへ到達する唯一の
  経路なので、数字のような「読むための要素」に隠さず、押せるものとして見える形で置く
- リンクが 1 本の軸は external-link アイコン、複数本（混在軸）は行と同じ種別アイコンで描く。
  同じアイコンを 2 つ並べると押し分けられない
- 見出しを scroll コンテナの**外**に置く。ペインが独立して縦スクロールするため、見出しは
  スクロールの影響を受けない位置に固定されていればよく、sticky で追従させる必要がない
- 件数が 0 のペインも枠ごと残す。消すとペインの並び順と幅が状況で変わり、「レビュー依頼が
  無い」ことと「そのペインが存在しない」ことが区別できなくなる
- `min-w-0` を置く。flex item の既定 `min-width: auto` は中身の最小幅で下限が決まるため、
  これが無いと長いタイトルがペインを押し広げてパネルが横スクロールする
- 未読だけを出す絞り込みは親から受け取り、間引きはここで行う。絞り込みは表示の関心なので、
  渡された `group` は取得結果のまま扱う。取得件数と総件数の対が持つ「上限で切れたか」の
  意味を、表示側の都合で書き換えない
</doc>

<script setup lang="ts">
import type { GitMyWorkGroup } from "@gozd/rpc";
import { computed } from "vue";
import { activateExternalLink, ITEM_KIND_DISPLAY } from "../github-item";
import { isMyWorkTruncated, myWorkCountDisplay, myWorkEmptyMessage } from "./myWorkCountDisplay";
import MyWorkRow from "./MyWorkRow.vue";
import IconLucideExternalLink from "~icons/lucide/external-link";

const props = defineProps<{ title: string; group: GitMyWorkGroup; unreadOnly: boolean }>();

/** 実際に描く行。絞り込みは表示の関心なので、取得結果である `group` は元のまま扱う */
const visibleItems = computed(() =>
  props.unreadOnly ? props.group.items.filter((item) => item.isUnread) : props.group.items,
);

/** 見出し右端のリンク。1 本なら軸名で足りるが、複数本は種別で区別する */
const links = computed(() => {
  const isSingle = props.group.webLinks.length === 1;
  return props.group.webLinks.map((link) => ({
    url: link.url,
    icon: isSingle ? IconLucideExternalLink : ITEM_KIND_DISPLAY[link.kind].icon,
    title: isSingle
      ? `Open "${props.title}" on GitHub`
      : `Open "${props.title}" ${ITEM_KIND_DISPLAY[link.kind].label} on GitHub`,
  }));
});

/** 件数表示の入力。取得結果と絞り込みの状態だけで決まる */
const countInput = computed(() => ({
  unreadOnly: props.unreadOnly,
  visibleCount: visibleItems.value.length,
  fetchedCount: props.group.items.length,
  totalCount: props.group.totalCount,
}));

/** 取得上限で切れているか。数字の色を切り替えるためだけに使う（表記の判断は表示側が持つ） */
const isTruncated = computed(() => isMyWorkTruncated(countInput.value));

const countDisplay = computed(() => myWorkCountDisplay(countInput.value));

const emptyMessage = computed(() => myWorkEmptyMessage(props.unreadOnly));
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col border-r border-border last:border-r-0">
    <h3
      class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[10px] font-medium tracking-wide text-foreground-low uppercase"
    >
      <!-- 見出しと件数を 1 つの伸びる箱に入れ、リンクを右端へ押し出す（margin を使わない） -->
      <span class="flex min-w-0 flex-1 items-center gap-2">
        <span class="min-w-0 truncate">{{ title }}</span>
        <span
          class="shrink-0 tabular-nums"
          :class="isTruncated ? 'text-warning-text' : 'text-foreground-muted'"
          :title="countDisplay.title"
        >
          {{ countDisplay.label }}
        </span>
      </span>
      <a
        v-for="link in links"
        :key="link.url"
        :href="link.url"
        class="grid size-5 shrink-0 place-items-center rounded-sm text-foreground-muted no-underline hover:bg-element-hover hover:text-foreground"
        :title="link.title"
        :aria-label="link.title"
        @click="activateExternalLink($event, link.url)"
        @auxclick="activateExternalLink($event, link.url)"
      >
        <component :is="link.icon" class="size-3.5" />
      </a>
    </h3>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <p v-if="visibleItems.length === 0" class="p-3 text-xs text-foreground-muted">
        {{ emptyMessage }}
      </p>
      <MyWorkRow v-for="item in visibleItems" v-else :key="item.url" :item="item" />
    </div>
  </section>
</template>
