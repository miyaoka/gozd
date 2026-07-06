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

// 選択と HEAD は別軸。選択を最優先、次に HEAD 行の持続背景、通常は hover のみ。
const highlightClass = computed(() => {
  if (gitGraphStore.isSelectedRow(props.node.commit.hash))
    return "bg-primary-subtle hover:bg-primary-subtle-hover";
  // HEAD 行は lane 0 (HEAD 予約色 teal/green) 帯で示す。graph 専用色なので token 非依存で直接指定。
  if (props.node.commit.hash === gitGraphStore.headHash)
    return "bg-[#50da6336] hover:bg-[#50da634d]";
  return "hover:bg-element-hover";
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
    :style="{ height: `${ROW_HEIGHT}px` }"
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
