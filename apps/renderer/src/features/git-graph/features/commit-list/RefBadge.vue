<doc lang="md">
Branch ref badge with optional PR link. Displays a PR number badge, its CI / comment indicators,
and the branch label (in that order).

## PR インジケータ

PR 番号バッジの後ろに CI ドットとコメント数を並べる。何を出さないかの契約は
[docs/git.md](../../../../../../../docs/git.md) の「PR 一覧が運ぶ情報の範囲」。

`checkState` が undefined なのは **check が 1 つも登録されていない commit** であって、失敗でも
取得漏れでもない。CI を持たない repo に加え、push 直後に GitHub が check を作るまでの過渡状態も
ここに落ちるため、push のたびにドットが一瞬消えてから復帰する。

値は PR 一覧の polling が運ぶため即時ではない。CI 実行中の PENDING → SUCCESS 遷移は最大
1 周期ぶん遅れて反映される。

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
import { CHECK_STATE_DISPLAY } from "../../checkStateDisplay";
import { activateExternalLink } from "../../externalLink";
import type { DisplayRef } from "./displayRef";
import IconLucideGitPullRequest from "~icons/lucide/git-pull-request";
import IconLucideLink from "~icons/lucide/link";
import IconLucideLink2Off from "~icons/lucide/link-2-off";
import IconLucideMessageSquare from "~icons/lucide/message-square";

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

/** CI ドットの表示。check 未登録 (`checkState` undefined) ならドットごと出さない */
const checkDot = computed(() => {
  const state = pr.value?.checkState;
  return state === undefined ? undefined : CHECK_STATE_DISPLAY[state];
});
</script>

<template>
  <!-- PR number badge + CI / comment indicators (left of branch label) -->
  <template v-if="pr">
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
  </template>
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
