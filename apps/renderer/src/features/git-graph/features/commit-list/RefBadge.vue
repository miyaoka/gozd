<doc lang="md">
Branch ref badge with optional PR link. Displays a PR number badge (left) and branch label (right).

## カラー設計

ref を **current / default / other** の 3 カテゴリで固定色に振り分ける (original PR #170e6b33 と
同じ構造、Tier 2 semantic token に翻訳しただけ):

- `isCurrent` (HEAD branch、最優先): warning solid (`bg-warning text-warning-foreground`)。
  type に関わらず override
- `isDefault` (default branch、isCurrent でない): type 色に `ring-1 ring-inset ring-current` を
  decoration として add
- 上記いずれでもない (type 別): branch は `bg-success-subtle text-success-text`、tag は
  `bg-primary-subtle text-primary-text`

local / remote は **同じ hue で明度差** で区別する:

- local / synced: 上記 token を full
- remote: 同じ token + `opacity-50` で dim (data-state dim は SKILL Alpha 表の allow-list 用途)
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/rpc";
import { computed } from "vue";
import type { DisplayRef } from "./displayRef";
import IconLucideGitPullRequest from "~icons/lucide/git-pull-request";
import IconLucideLink from "~icons/lucide/link";
import IconLucideLink2Off from "~icons/lucide/link-2-off";

const props = defineProps<{
  displayRef: DisplayRef;
  prByBranch: Map<string, GitPullRequest>;
}>();

/** DisplayRef からブランチ名を抽出し、対応する PR を返す */
const pr = computed(() => {
  if (props.displayRef.type === "tag" || props.displayRef.type === "local") return undefined;
  const branchName =
    props.displayRef.type === "remote"
      ? props.displayRef.label.slice("origin/".length)
      : props.displayRef.label;
  return props.prByBranch.get(branchName);
});

/**
 * type 別の base class。current / default の override / decoration はテンプレ側で合成する。
 * remote は同 hue + opacity-50 で dim (data state、SKILL Alpha allow-list)。
 */
const REF_TYPE_CLASS: Record<DisplayRef["type"], string> = {
  synced: "bg-success-subtle text-success-text",
  local: "bg-success-subtle text-success-text",
  remote: "bg-success-subtle text-success-text opacity-50",
  tag: "bg-primary-subtle text-primary-text",
};

/** HEAD branch tip。type を override して warning solid に。remote 版は dim */
const CURRENT_LOCAL_CLASS = "bg-warning text-warning-foreground";
const CURRENT_REMOTE_CLASS = "bg-warning text-warning-foreground opacity-50";

/** default branch decoration。type 色の上に ring を重ねる */
const DEFAULT_CLASS = "ring-1 ring-inset ring-current";
</script>

<template>
  <!-- PR number badge (left of branch label) -->
  <!-- 外部リンクは main 側の navigation 防壁 (setWindowOpenHandler) が OS のブラウザに渡す。
       `target="_blank" rel="noopener noreferrer"` は防壁が deny するまでの thin window に
       エンジンが referrer / opener を組み立てる可能性に対する defense in depth。
       行クリック伝播は `@click.stop` で止める。 -->
  <a
    v-if="pr"
    :href="pr.url"
    target="_blank"
    rel="noopener noreferrer"
    class="flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] leading-none font-medium no-underline"
    :class="pr.isDraft ? 'bg-element text-foreground' : 'bg-primary-subtle text-primary-text'"
    :title="`PR #${pr.number}${pr.isDraft ? ' (draft)' : ''}`"
    @click.stop
  >
    <IconLucideGitPullRequest class="size-3" />
    #{{ pr.number }}
  </a>
  <!-- Branch / tag label -->
  <span
    class="flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] leading-none font-medium"
    :class="[
      displayRef.isCurrent
        ? displayRef.type === 'remote'
          ? CURRENT_REMOTE_CLASS
          : CURRENT_LOCAL_CLASS
        : REF_TYPE_CLASS[displayRef.type],
      displayRef.isDefault && DEFAULT_CLASS,
    ]"
  >
    <IconLucideLink v-if="displayRef.isSynced" class="size-3" />
    <IconLucideLink2Off v-else-if="displayRef.isOutOfSync" class="size-3" />
    {{ displayRef.label }}
  </span>
</template>
