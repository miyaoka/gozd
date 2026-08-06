<doc lang="md">
my work パネルの 1 ペイン（review requested / my PRs / my issues）。

## 設計判断

- 見出しに出す数は **検索条件に一致する総件数**。取得は上限で切られるため、表示件数だけを
  出すと「上限ちょうどで止まっている」のか「たまたま同数」なのかが区別できない
- 切れているときだけ `表示件数 / 総件数` の形にする。切れていないときに常に併記すると、
  同じ数字が 2 つ並ぶだけで読む側の負荷が増える
- 見出しを scroll コンテナの**外**に置く。ペインが独立して縦スクロールするため、見出しは
  スクロールの影響を受けない位置に固定されていればよく、sticky で追従させる必要がない
- 件数が 0 のペインも枠ごと残す。消すとペインの並び順と幅が状況で変わり、「レビュー依頼が
  無い」ことと「そのペインが存在しない」ことが区別できなくなる
- `min-w-0` を置く。flex item の既定 `min-width: auto` は中身の最小幅で下限が決まるため、
  これが無いと長いタイトルがペインを押し広げてパネルが横スクロールする
</doc>

<script setup lang="ts">
import type { GitMyWorkGroup } from "@gozd/rpc";
import { computed } from "vue";
import MyWorkRow from "./MyWorkRow.vue";

const props = defineProps<{ title: string; group: GitMyWorkGroup }>();

/** 取得上限で切れているか。真偽値を境界で運ばず、総件数と表示件数の比較で導出する */
const isTruncated = computed(() => props.group.totalCount > props.group.items.length);

const countLabel = computed(() =>
  isTruncated.value
    ? `${props.group.items.length} / ${props.group.totalCount}`
    : `${props.group.totalCount}`,
);

const countTitle = computed(() =>
  isTruncated.value
    ? `Showing ${props.group.items.length} of ${props.group.totalCount} (most recently updated)`
    : `${props.group.totalCount} total`,
);
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col border-r border-border last:border-r-0">
    <h3
      class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[10px] font-medium tracking-wide text-foreground-low uppercase"
    >
      <span class="min-w-0 truncate">{{ title }}</span>
      <span
        class="shrink-0 tabular-nums"
        :class="isTruncated ? 'text-warning-text' : 'text-foreground-muted'"
        :title="countTitle"
      >
        {{ countLabel }}
      </span>
    </h3>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <p v-if="group.items.length === 0" class="p-3 text-xs text-foreground-muted">Nothing here</p>
      <MyWorkRow v-for="item in group.items" v-else :key="item.url" :item="item" />
    </div>
  </section>
</template>
