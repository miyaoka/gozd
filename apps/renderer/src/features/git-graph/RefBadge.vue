<doc lang="md">
Branch ref badge with optional PR link. Displays a PR number badge (left) and branch label (right).
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/rpc";
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
  synced: "bg-green-800 text-green-200",
  local: "bg-green-800 text-green-200",
  remote: "bg-green-800 text-green-200 opacity-50",
  tag: "bg-blue-800 text-blue-200",
};

const CURRENT_LOCAL_CLASS = "bg-yellow-500 text-black";
const CURRENT_REMOTE_CLASS = "bg-yellow-500 text-black opacity-50";
const DEFAULT_CLASS = "ring-1 ring-inset ring-current";

function openPrUrl(url: string) {
  window.open(url);
}
</script>

<template>
  <!-- PR number badge (left of branch label) -->
  <span
    v-if="pr"
    class="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] leading-none font-medium"
    :class="pr.isDraft ? 'bg-zinc-700 text-zinc-300' : 'bg-purple-800 text-purple-200'"
    :title="`PR #${pr.number}${pr.isDraft ? ' (draft)' : ''}`"
    @click.stop="openPrUrl(pr.url)"
  >
    <span class="icon-[lucide--git-pull-request] size-3" />
    #{{ pr.number }}
  </span>
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
