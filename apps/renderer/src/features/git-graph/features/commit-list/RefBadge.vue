<doc lang="md">
ブランチ / タグの ref バッジ。PR を持つ ref では PR 番号と CI 状態、コメント数を先に並べ、
ブランチ名を続ける。

## PR インジケータ

PR 番号バッジの後ろに CI ドットとコメント数を並べる。何を出さないかの契約は
docs/git.md の「PR 一覧が運ぶ情報の範囲」。

PR 番号とコメント数は **PR 単位**の値なので、branch を指す ref にはすべて出す（tag は対象外）。
local と origin が別コミットに分かれていても出す — stack を積み替える運用ではずれている状態が
常態で、「同じコミットに居るときだけ出す」にすると PR を持つ branch からバッジが消える。

**CI ドットだけは commit 単位**の値で、PR head ref に対する結果を指す。`origin/<branch>` が
載っている行にだけ描く（判定とその限界は `graphRefs.ts` の `hasOriginRef`）。

ずれていること自体はこのバッジでは示せない。link アイコンは local と origin の両方がグラフに
載っているときしか判定できず、載っていない scope ではどちらのアイコンも付かない。**PR バッジは
出るがずれは見えない**状態になる。

PR バッジが出ている行でドットが無いのは、origin が載っていないか、check が未登録かのどちらか。

`checkState` が undefined なのは **check が 1 つも登録されていない commit** であって、失敗でも
取得漏れでもない。CI を持たない repo に加え、push 直後に GitHub が check を作るまでの過渡状態も
ここに落ちるため、push のたびにドットが一瞬消えてから復帰する。

値は PR 一覧の取得が運ぶため即時ではない。CI の進行は取得の間隔ぶん遅れて反映される。

## カラー設計

ref は **current / default / それ以外**の 3 段で塗り分ける。**この序列は ref の種別
(branch / tag) より優先する**。「いまどこに居るか」は種別より先に知りたい情報で、種別を
優先して色を割ると HEAD が他のブランチに埋もれる。

- current は単独で最も強い塗り。種別の色を上書きする
- default は種別の色を保ったまま囲みだけを足す。種別の情報を落とさずに 1 段だけ持ち上げる
- それ以外は種別ごとの色

local と remote は**同じ色相のまま明度だけを変える**。別の色を割り当てると、同じブランチの
local と remote が無関係な 2 つに見える。
</doc>

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
