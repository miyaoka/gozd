<doc lang="md">
Branch ref badge with optional PR link. Displays a PR number badge (left) and branch label (right).

## カラー設計

ref の hue は **branch 名単位で固定** する (`displayRef.laneColorIndex` = GitGraphPane の
`branchLaneByName` 由来)。同じ branch 名なら local / synced / remote すべて同 hue になり、
out-of-sync で local と remote が別 commit に乗っていても色が割れない。lane 0 (teal) は
HEAD branch に予約。

実体上の DisplayRef type は `local | synced | remote | tag` の 4 値:

- `local`: branch 名に local ref のみ、remote ref 無し
- `synced`: 同一 commit 上に local と origin/同名が両方ある (computeDisplayRefs で merge され
  DisplayRef は 1 個に統合される)
- `remote`: branch 名に origin/\* のみ、local ref 無し (pure remote)
- `tag`: tag ref

色マッピング:

- `local` / `synced`: lane hue full saturation の text + lane hue subtle bg
  (`laneTextColor` + `laneSubtleBgColor`)
- `remote`: 同じ lane hue を低 L / 低 C に倒した text (`laneRemoteTextColor`) + bg は local と
  共通 (`laneSubtleBgColor`)。「同じ branch の remote 側 = 一段 dim」を表現
- `tag`: branch とは別概念なので primary-subtle (lane 色に乗らない)
- `isCurrent`: HEAD branch tip を warning solid で強調 (lane 色より上に立つ攻撃的ハイライト)。
  `isCurrent && remote` は warning-subtle で「remote HEAD pointer」

8 lane × 3 variant (text local / text remote / bg) を Tier 2 token に展開すると alias 表が
肥大化するため、`graphColors.ts` の動的計算色を inline `:style` で渡す
([gozd-ui SKILL の inline style 例外 (c) 動的計算色 (有限固定 palette / per-identifier 動的値)](../../../../../.claude/skills/gozd-ui/SKILL.md))。
</doc>

<script setup lang="ts">
import type { GitPullRequest } from "@gozd/proto";
import { computed } from "vue";
import type { DisplayRef } from "./displayRef";
import { laneRemoteTextColor, laneSubtleBgColor, laneTextColor } from "./graphColors";

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
 * branch (local / remote / synced) は lane 色を inline style で適用する。
 * tag は branch ではないため lane 色に乗らず、primary-subtle (Tier 2 token) を使う。
 * isCurrent は warning 系で上書きされるためここも fallback class 側に流す。
 */
const isBranch = computed(() => props.displayRef.type !== "tag" && !props.displayRef.isCurrent);

const branchStyle = computed<Record<string, string> | undefined>(() => {
  if (!isBranch.value) return undefined;
  const idx = props.displayRef.laneColorIndex;
  const text = props.displayRef.type === "remote" ? laneRemoteTextColor(idx) : laneTextColor(idx);
  return {
    backgroundColor: laneSubtleBgColor(idx),
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
