<doc lang="md">
my work パネルの 1 行。PR と issue を同じ行フォーマットで描く。

## 設計判断

- リンクは `a[href]` にする。クリックは `activateExternalLink` が OS のブラウザへ渡すため
  href は遷移させないが、外すと link の意味論（キーボードフォーカス到達、Enter 起動、
  支援技術への露出）が同時に落ちる
- 2 行構成にして 1 行目をタイトル専用にする。repo をまたぐ一覧なので `owner/name` が
  常に必要で、同じ行に置くとタイトルの可読幅がほとんど残らない
- `checkState` が undefined なのは **check が 1 つも登録されていない PR** であって取得漏れ
  ではない。issue も同じ undefined に落ちるため、ドットごと出さない（欠けた要約を
  「不明」として描かない契約は docs/git.md）
- CI ドットは装飾ではなく状態を運ぶ図形なので、支援技術にも露出させる（`RefBadge` の
  同じドットと同じ扱い）
- 未読は行頭のバーで表す。行内には既に CI の色付きドットがあるので、同じ図形をもう 1 つ
  足さず別のチャネルへ逃がす
- バーに primary を使う。この一覧では未読の行が対応すべき対象で、読み終えた行は用が
  済んでいる。未読はこのパネルの active state そのもの。**行の選択という状態は存在しない**
  （行はクリックで外部ブラウザへ渡すリンクで、選択もキーボードカーソルも持たない）ため、
  active を表す色が他の意味と競合しない
- バーは既読の行にも透明で常設する。未読の行にだけ足すと、その行の内容だけ横にずれる
- バーは視覚にしか出ないため、未読であることを読み上げ用のテキストで併記する
</doc>

<script setup lang="ts">
import type { GitMyWorkItem } from "@gozd/rpc";
import { computed } from "vue";
import { formatRelativeAge, isoToUnixSec } from "../../shared/time";
import {
  activateExternalLink,
  CHECK_STATE_DISPLAY,
  ITEM_KIND_DISPLAY,
  REVIEW_DECISION_DISPLAY,
} from "../github-item";
import IconLucideMessageSquare from "~icons/lucide/message-square";

const props = defineProps<{ item: GitMyWorkItem }>();

const checkDot = computed(() => {
  const state = props.item.checkState;
  return state === undefined ? undefined : CHECK_STATE_DISPLAY[state];
});

const reviewDecision = computed(() => {
  const decision = props.item.reviewDecision;
  return decision === undefined ? undefined : REVIEW_DECISION_DISPLAY[decision];
});

const dateDisplay = computed(() => formatRelativeAge(isoToUnixSec(props.item.updatedAt)));
</script>

<template>
  <a
    :href="item.url"
    class="flex flex-col gap-1 border-b border-l-2 border-border-subtle px-3 py-2 text-xs no-underline hover:bg-element-hover"
    :class="item.isUnread ? 'border-l-primary' : 'border-l-transparent'"
    @click="activateExternalLink($event, item.url)"
    @auxclick="activateExternalLink($event, item.url)"
  >
    <span v-if="item.isUnread" class="sr-only">Unread</span>

    <div class="flex items-start gap-2">
      <component
        :is="ITEM_KIND_DISPLAY[item.kind].icon"
        class="size-3.5 shrink-0 translate-y-px"
        :class="item.isDraft ? 'text-foreground-muted' : 'text-success-text'"
      />
      <span class="min-w-0 flex-1 truncate text-foreground">{{ item.title }}</span>
      <span class="shrink-0 tabular-nums" :class="dateDisplay.color">{{ dateDisplay.text }}</span>
    </div>

    <div class="flex items-center gap-2 text-[10px] text-foreground-low">
      <span class="min-w-0 truncate">{{ item.repo }}</span>
      <span class="shrink-0 tabular-nums">#{{ item.number }}</span>
      <span v-if="item.isDraft" class="shrink-0 rounded-sm bg-element px-1 text-foreground-muted">
        draft
      </span>
      <span v-if="reviewDecision !== undefined" class="shrink-0" :class="reviewDecision.class">
        {{ reviewDecision.label }}
      </span>

      <span class="flex flex-1 items-center justify-end gap-2">
        <span
          v-if="checkDot !== undefined"
          role="img"
          class="size-1.5 shrink-0 rounded-full"
          :class="checkDot.class"
          :title="checkDot.title"
          :aria-label="checkDot.title"
        ></span>
        <span
          v-if="item.commentCount > 0"
          class="flex shrink-0 items-center gap-0.5 tabular-nums"
          :title="`Comments: ${item.commentCount}`"
        >
          <IconLucideMessageSquare class="size-2.5" />
          {{ item.commentCount }}
        </span>
        <img
          v-if="item.authorAvatarUrl !== ''"
          :src="item.authorAvatarUrl"
          :alt="item.author"
          :title="item.author"
          class="size-4 shrink-0 rounded-full"
        />
      </span>
    </div>
  </a>
</template>
