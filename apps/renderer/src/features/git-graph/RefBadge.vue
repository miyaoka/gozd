<doc lang="md">
Branch ref badge with optional PR link. Displays a PR number badge (left) and branch label (right).
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/proto";
import { computed } from "vue";
import type { DisplayRef } from "./displayRef";

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

const REF_TYPE_CLASS: Record<DisplayRef["type"], string> = {
  synced: "bg-success/15 text-success-text",
  local: "bg-success/15 text-success-text",
  remote: "bg-success/15 text-success-text opacity-50",
  tag: "bg-primary/15 text-primary-text",
};

const CURRENT_LOCAL_CLASS = "bg-warning text-background";
const CURRENT_REMOTE_CLASS = "bg-warning text-background opacity-50";
const DEFAULT_CLASS = "ring-1 ring-inset ring-current";
</script>

<template>
  <!-- PR number badge (left of branch label) -->
  <!-- 外部リンクは native 側の `ExternalLinkNavigationDecider` が OS のブラウザに渡す。
       `target="_blank" rel="noopener noreferrer"` は decider 経路が完全に握る前 (decider が
       cancel するまでの thin window) に WebKit が referrer / opener を組み立てる可能性に対する
       defense in depth。行クリック伝播は `@click.stop` で止める。 -->
  <a
    v-if="pr"
    :href="pr.url"
    target="_blank"
    rel="noopener noreferrer"
    class="flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] leading-none font-medium no-underline"
    :class="pr.isDraft ? 'bg-element text-foreground' : 'bg-primary/15 text-primary-text'"
    :title="`PR #${pr.number}${pr.isDraft ? ' (draft)' : ''}`"
    @click.stop
  >
    <span class="icon-[lucide--git-pull-request] size-3" />
    #{{ pr.number }}
  </a>
  <!-- Branch label -->
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
    <span v-if="displayRef.isSynced" class="icon-[lucide--link] size-3" />
    <span v-else-if="displayRef.isOutOfSync" class="icon-[lucide--link-2-off] size-3" />
    {{ displayRef.label }}
  </span>
</template>
