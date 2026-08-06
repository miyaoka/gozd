<doc lang="md">
my work パネルの 1 ペイン（review requested / my PRs / my issues）。

## 設計判断

- 見出しを scroll コンテナの**外**に置く。ペインが独立して縦スクロールするため、見出しは
  スクロールの影響を受けない位置に固定されていればよく、sticky で追従させる必要がない
- 件数が 0 のペインも枠ごと残す。消すとペインの並び順と幅が状況で変わり、「レビュー依頼が
  無い」ことと「そのペインが存在しない」ことが区別できなくなる
- `min-w-0` を置く。flex item の既定 `min-width: auto` は中身の最小幅で下限が決まるため、
  これが無いと長いタイトルがペインを押し広げてパネルが横スクロールする
</doc>

<script setup lang="ts">
import type { GitMyWorkItem } from "@gozd/rpc";
import MyWorkRow from "./MyWorkRow.vue";

defineProps<{ title: string; items: GitMyWorkItem[] }>();
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col border-r border-border last:border-r-0">
    <h3
      class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[10px] font-medium tracking-wide text-foreground-low uppercase"
    >
      <span class="min-w-0 truncate">{{ title }}</span>
      <span class="shrink-0 text-foreground-muted tabular-nums">{{ items.length }}</span>
    </h3>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <p v-if="items.length === 0" class="p-3 text-xs text-foreground-muted">Nothing here</p>
      <MyWorkRow v-for="item in items" v-else :key="item.url" :item="item" />
    </div>
  </section>
</template>
