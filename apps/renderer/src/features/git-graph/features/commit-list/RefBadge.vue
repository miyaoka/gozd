<script setup lang="ts">
import type { GitPullRequestBadge } from "@gozd/rpc";
import { computed } from "vue";
import { activateExternalLink, CHECK_STATE_DISPLAY } from "../../../github-item";
import type { DisplayRef } from "./displayRef";
import { hasOriginRef, prLookupBranch } from "./graphRefs";
import IconLucideGitPullRequest from "~icons/lucide/git-pull-request";
import IconLucideLink from "~icons/lucide/link";
import IconLucideLink2Off from "~icons/lucide/link-2-off";
import IconLucideMessageSquare from "~icons/lucide/message-square";

const props = defineProps<{
  displayRef: DisplayRef;
  prByBranch: Map<string, GitPullRequestBadge>;
}>();

/** DisplayRef からブランチ名を抽出し、対応する PR を返す */
const pr = computed(() => {
  const branchName = prLookupBranch(props.displayRef);
  if (branchName === undefined) return undefined;
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

/**
 * CI ドットの表示。check 未登録 (`checkState` undefined) ならドットごと出さない。
 * `origin/<branch>` が載っていない行にも出さない（`hasOriginRef` の doc 参照）。
 */
const checkDot = computed(() => {
  if (!hasOriginRef(props.displayRef)) return undefined;
  const state = pr.value?.checkState;
  return state === undefined ? undefined : CHECK_STATE_DISPLAY[state];
});

/** PR インジケータを dim するか。 */
const isDimmed = computed(() => !hasOriginRef(props.displayRef));
</script>

<template>
  <!-- PR number badge + CI / comment indicators (left of branch label)。
       gap は親 (CommitRow の ref 列) と同値にして、包んでも並びの見た目を変えない。 -->
  <span
    v-if="pr"
    class="_pr-indicators flex shrink-0 items-center gap-1"
    :class="isDimmed && 'opacity-50'"
  >
    <!-- クリックは `activateExternalLink` が OS のブラウザへ渡す。`href` は遷移させないが、外すと
         a[href] のリンク意味論 (キーボードフォーカス到達、Enter による起動、支援技術への link
         としての露出、UA の cursor: pointer) が同時に落ちる。no-underline のこのバッジでは
         カーソル形状が唯一の hover アフォーダンスでもある。 -->
    <a
      :href="pr.url"
      class="flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] leading-none font-medium no-underline"
      :class="pr.isDraft ? 'bg-element text-foreground' : 'bg-primary-subtle text-primary-text'"
      :title="`PR #${pr.number}${pr.isDraft ? ' (draft)' : ''}`"
      @click="activateExternalLink($event, pr.url)"
      @auxclick="activateExternalLink($event, pr.url)"
    >
      <IconLucideGitPullRequest class="size-3" />
      #{{ pr.number }}
    </a>
    <!-- CI rollup。装飾ではなく状態を運ぶ図形なので role="img" + aria-label で AT に露出する -->
    <span
      v-if="checkDot"
      class="size-2 shrink-0 rounded-full"
      :class="checkDot.class"
      role="img"
      :aria-label="checkDot.title"
      :title="checkDot.title"
    />
    <span
      v-if="pr.commentCount > 0"
      class="flex shrink-0 items-center gap-0.5 text-[10px] leading-none text-foreground-low"
      :title="`Comments: ${pr.commentCount}`"
    >
      <IconLucideMessageSquare class="size-3" />
      {{ pr.commentCount }}
    </span>
  </span>
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
