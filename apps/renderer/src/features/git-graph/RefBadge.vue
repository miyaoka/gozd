<doc lang="md">
Branch ref badge with optional PR link. Displays a PR number badge (left) and branch label (right).

## カラー設計

graph line と同じ lane 色で描画して「ブランチ ref と graph line が同じ色」を視覚的に
担保する。`laneColorIndex` は親 GitGraphPane が `node.color` (graphLayout のレーン色 index)
として渡す。

- `local` / `synced`: lane hue full saturation の text + lane hue subtle bg (subtle chip pattern を
  per-lane 展開)
- `remote`: 同じ lane hue を低明度 / 低 chroma に倒した text (`laneRemoteTextColor`)。bg は local と
  共通の `laneSubtleBgColor` で「同じ branch の remote 側 = 一段 dim」を表現
- `tag`: branch とは別概念なので primary-subtle (lane 色に乗らない)
- `isCurrent`: HEAD branch tip を warning solid で強調 (lane 色より上に立つ攻撃的ハイライト)

8 lane × 3 variant (text local / text remote / bg) を Tier 2 token に展開すると alias 表が
肥大化するため、`graphColors.ts` の動的計算色を inline `:style` で渡す
([gozd-ui SKILL の inline style 例外 (c) 動的計算色 (内部生成)](../../../../.claude/skills/gozd-ui/SKILL.md))。
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/proto";
import { computed } from "vue";
import type { DisplayRef } from "./displayRef";
import { laneRemoteTextColor, laneSubtleBgColor, laneTextColor } from "./graphColors";

const props = defineProps<{
  displayRef: DisplayRef;
  prByBranch: Map<string, GitPullRequest>;
  /** この commit が乗っている graph lane の color index。graph line と ref text の hue を揃える */
  laneColorIndex: number;
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
 * branch (local / remote / synced) は lane 色を inline style で適用する。
 * tag は branch ではないため lane 色に乗らず、primary-subtle (Tier 2 token) を使う。
 */
const isBranch = computed(() => props.displayRef.type !== "tag" && !props.displayRef.isCurrent);

const branchStyle = computed<Record<string, string> | undefined>(() => {
  if (!isBranch.value) return undefined;
  const text =
    props.displayRef.type === "remote"
      ? laneRemoteTextColor(props.laneColorIndex)
      : laneTextColor(props.laneColorIndex);
  return {
    backgroundColor: laneSubtleBgColor(props.laneColorIndex),
    color: text,
  };
});

/**
 * tag は branch とは別 hue (primary-subtle) を Tier 2 token で当てる。
 * isCurrent は warning solid (HEAD tip 強調)、isCurrent && remote は warning-subtle で「remote HEAD pointer」。
 */
const fallbackClass = computed(() => {
  if (props.displayRef.isCurrent) {
    return props.displayRef.type === "remote"
      ? "bg-warning-subtle text-warning-text"
      : "bg-warning text-warning-foreground";
  }
  if (props.displayRef.type === "tag") {
    return "bg-primary-subtle text-primary-text";
  }
  return "";
});

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
    :class="pr.isDraft ? 'bg-element text-foreground' : 'bg-primary-subtle text-primary-text'"
    :title="`PR #${pr.number}${pr.isDraft ? ' (draft)' : ''}`"
    @click.stop
  >
    <span class="icon-[lucide--git-pull-request] size-3" />
    #{{ pr.number }}
  </a>
  <!-- Branch / tag label -->
  <span
    class="flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] leading-none font-medium"
    :class="[fallbackClass, displayRef.isDefault && DEFAULT_CLASS]"
    :style="branchStyle"
  >
    <span v-if="displayRef.isSynced" class="icon-[lucide--link] size-3" />
    <span v-else-if="displayRef.isOutOfSync" class="icon-[lucide--link-2-off] size-3" />
    {{ displayRef.label }}
  </span>
</template>
