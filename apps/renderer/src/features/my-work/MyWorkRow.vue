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
  「不明」として描かない契約は [docs/git.md](../../../../../docs/git.md)）
- CI ドットは装飾ではなく状態を運ぶ図形なので、支援技術にも露出させる（`RefBadge` の
  同じドットと同じ扱い）
</doc>

<script setup lang="ts">
import type { GitMyWorkItem, GitPullRequestReviewDecision } from "@gozd/rpc";
import { computed, type FunctionalComponent, type SVGAttributes } from "vue";
import { formatRelativeTime } from "../../shared/time";
import { activateExternalLink, CHECK_STATE_DISPLAY } from "../git-graph";
import IconLucideCircleDot from "~icons/lucide/circle-dot";
import IconLucideGitPullRequest from "~icons/lucide/git-pull-request";
import IconLucideMessageSquare from "~icons/lucide/message-square";

const props = defineProps<{ item: GitMyWorkItem }>();

/** レビュー総合結果 → ラベルと色。設定の無い PR / issue は undefined で、行に何も出さない */
const REVIEW_DECISION_DISPLAY: Record<
  GitPullRequestReviewDecision,
  { label: string; class: string }
> = {
  APPROVED: { label: "approved", class: "text-success-text" },
  CHANGES_REQUESTED: { label: "changes requested", class: "text-destructive-text" },
  REVIEW_REQUIRED: { label: "review required", class: "text-foreground-muted" },
};

const KIND_ICON: Record<GitMyWorkItem["kind"], FunctionalComponent<SVGAttributes>> = {
  pr: IconLucideGitPullRequest,
  issue: IconLucideCircleDot,
};

const checkDot = computed(() => {
  const state = props.item.checkState;
  return state === undefined ? undefined : CHECK_STATE_DISPLAY[state];
});

const reviewDecision = computed(() => {
  const decision = props.item.reviewDecision;
  return decision === undefined ? undefined : REVIEW_DECISION_DISPLAY[decision];
});

// 経過が長いほど注意を引かない配色にする。放置された項目を警告色で塗り続けても行動は変わらず、
// 直近動いたものを見つけにくくするだけ
const RELATIVE_AGE_CLASS = [
  { withinSec: 3600, class: "text-success-text" },
  { withinSec: 86400, class: "text-warning-text" },
  { withinSec: 86400 * 7, class: "text-warning-strong-text" },
] as const;

/** ISO 8601 → Unix 秒。parse 不能なら 0（`formatRelativeTime` が空文字を返す） */
const updatedAtSec = computed(() => {
  const ms = Date.parse(props.item.updatedAt);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
});

const relativeText = computed(() => formatRelativeTime(updatedAtSec.value));

const relativeClass = computed(() => {
  if (updatedAtSec.value <= 0) return "text-foreground-muted";
  const ageSec = Math.floor(Date.now() / 1000) - updatedAtSec.value;
  return RELATIVE_AGE_CLASS.find((band) => ageSec < band.withinSec)?.class ?? "text-foreground-low";
});
</script>

<template>
  <a
    :href="item.url"
    class="flex flex-col gap-1 border-b border-border-subtle px-3 py-2 text-xs no-underline hover:bg-element-hover"
    @click="activateExternalLink($event, item.url)"
    @auxclick="activateExternalLink($event, item.url)"
  >
    <div class="flex items-start gap-2">
      <component
        :is="KIND_ICON[item.kind]"
        class="size-3.5 shrink-0 translate-y-px"
        :class="item.isDraft ? 'text-foreground-muted' : 'text-success-text'"
      />
      <span class="min-w-0 flex-1 truncate text-foreground">{{ item.title }}</span>
      <span class="shrink-0 tabular-nums" :class="relativeClass">{{ relativeText }}</span>
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
