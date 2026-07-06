<doc lang="md">
commit graph の 1 コミット行。選択ハイライトは `useGitGraphStore` から導出する。
contextmenu は preventDefault し anchor / 座標をその場で snapshot して emit する
(pointerup 待機中に e.currentTarget が null 化するため)。
</doc>

<script setup lang="ts">
import type { GitCommit, GitPullRequest } from "@gozd/rpc";
import { computed } from "vue";
import { formatCompactTime } from "../../../../shared/time";
import CommitSegmentList from "../../CommitSegmentList";
import type { CommitMessageSegment } from "../../linkifyCommitMessage";
import { useGitGraphStore } from "../../useGitGraphStore";
import { HEAD_ROW_BG, HEAD_ROW_BG_HOVER } from "./graphColors";
import { ROW_HEIGHT } from "./graphGeometry";
import type { GraphNode } from "./graphLayout";
import { computeDisplayRefs } from "./graphRefs";
import RefBadge from "./RefBadge.vue";
import IconLucideGitMerge from "~icons/lucide/git-merge";

const props = defineProps<{
  node: GraphNode;
  /** HEAD が指すカレントブランチ名 (ref を current タイプに分類する) */
  currentBranch?: string;
  /** デフォルトブランチ名 (ref を default タイプに分類する) */
  defaultBranch?: string;
  /** ローカルとリモートが別コミットに分かれているブランチ名の集合 */
  outOfSyncBranches: Set<string>;
  /** ブランチ名 → PR のマップ (RefBadge が PR バッジを出すのに使う) */
  prByBranch: Map<string, GitPullRequest>;
  /** linkify 済みのコミットメッセージ segments */
  segments: CommitMessageSegment[];
}>();

const emit = defineEmits<{
  rowClick: [hash: string, e: MouseEvent];
  /** 右クリック。anchor / 座標は発火時点で snapshot 済み (pointerup 待機で currentTarget が失われるため) */
  rowContextmenu: [payload: { hash: string; anchorEl: HTMLElement; x: number; y: number }];
}>();

const gitGraphStore = useGitGraphStore();

const isSelectedRow = computed(() => gitGraphStore.isSelectedRow(props.node.commit.hash));
const isHeadRow = computed(() => props.node.commit.hash === gitGraphStore.headHash);

// 選択と HEAD は別軸。選択を最優先、次に HEAD 行の持続背景、通常は hover のみ。
// HEAD 帯は CSS 変数 (--head-bg / --head-bg-hover) を rowStyle が供給し、静的な bg / hover class で参照する。
// 色を class リテラルに直書きしない (graphColors 由来で Tailwind の静的スキャンに乗らないため) が、
// 変数名は固定なので class はスキャンでき、hover も cascade で効く (inline background だと hover が付けられない)。
const highlightClass = computed(() => {
  if (isSelectedRow.value) return "bg-primary-subtle hover:bg-primary-subtle-hover";
  if (isHeadRow.value) return "bg-[var(--head-bg)] hover:bg-[var(--head-bg-hover)]";
  return "hover:bg-element-hover";
});

// HEAD 帯の色源は graphColors の HEAD lane 色 (リング / ドットと同一 SSOT)。選択が勝つときは供給しない。
const rowStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = { height: `${ROW_HEIGHT}px` };
  if (isHeadRow.value && !isSelectedRow.value) {
    style["--head-bg"] = HEAD_ROW_BG;
    style["--head-bg-hover"] = HEAD_ROW_BG_HOVER;
  }
  return style;
});

const displayRefs = computed(() =>
  computeDisplayRefs(
    props.node.commit.refs,
    props.currentBranch,
    props.defaultBranch,
    props.outOfSyncBranches,
  ),
);

function isMergeCommit(commit: GitCommit): boolean {
  return commit.parents.length > 1;
}

function onContextmenu(e: MouseEvent) {
  if (!(e.currentTarget instanceof HTMLElement)) return;
  e.preventDefault();
  emit("rowContextmenu", {
    hash: props.node.commit.hash,
    anchorEl: e.currentTarget,
    x: e.clientX,
    y: e.clientY,
  });
}
</script>

<template>
  <div
    class="_graph-row col-span-full grid grid-cols-subgrid items-center text-xs"
    :class="highlightClass"
    :style="rowStyle"
    @click="emit('rowClick', node.commit.hash, $event)"
    @contextmenu="onContextmenu"
  >
    <!-- col 1 (graph): SVG が absolute で覆うセル。HEAD は SVG 側の dot リングで示すため、
         ここにはマーカーを置かない。 -->
    <div></div>

    <!-- col 2 (description) -->
    <div class="flex min-w-0 items-center gap-1 truncate px-1">
      <IconLucideGitMerge
        v-if="isMergeCommit(node.commit)"
        class="size-3.5 shrink-0 text-foreground-low"
      />
      <RefBadge
        v-for="displayRef in displayRefs"
        :key="`${displayRef.type}:${displayRef.label}`"
        :display-ref="displayRef"
        :pr-by-branch="prByBranch"
      />
      <span class="truncate">
        <CommitSegmentList :segments="segments" />
      </span>
    </div>

    <!-- col 3 (date) -->
    <div class="truncate px-1 text-foreground-low">
      {{ formatCompactTime(node.commit.date) }}
    </div>

    <!-- col 4 (author) -->
    <div class="truncate px-1 text-foreground-low">
      {{ node.commit.author }}
    </div>

    <!-- col 5 (hash) -->
    <div class="truncate px-1 font-mono text-foreground-low">
      {{ node.commit.shortHash }}
    </div>
  </div>
</template>
