<doc lang="md">
ダッシュボードの 1 行分のセル群。状態 glyph・タイトル・repo (アイコン付き)・ブランチ・
相対時刻を並べる (grid のカラム定義は DashboardDialog 側の container が持つ。
revive picker と同じ分業)。

## 状態列は全行が glyph を持つ

空白のセルは「状態なし」ではなく情報の欠落に見える (Carbon status indicator パターン /
VS Code agent view はどの状態にも glyph を割り当てる)。live な Claude 状態は
CLAUDE_STATE_VISUAL (色つき = high/medium attention)、Claude が動いていないセッションは
muted 単色の glyph で low attention に落とす。

## 相対時刻

開いている間 tick しない。数秒で閉じる transient な面であり、開き直しで再計算される。
</doc>

<script setup lang="ts">
import { computed, type FunctionalComponent, type SVGAttributes } from "vue";
import { formatRelativeAge } from "../../shared/time";
import { RepoIcon } from "../repo-icon";
import { CLAUDE_STATE_VISUAL, displayClaudeState } from "../terminal";
import type { DashboardRow } from "./collectDashboardRows";
import IconLucideCircle from "~icons/lucide/circle";

const props = defineProps<{
  row: DashboardRow;
}>();

/** Claude が動いていないセッションの low-attention glyph */
const IDLE_VISUAL = { icon: IconLucideCircle, ariaLabel: "Idle" };

interface StateGlyph {
  icon: FunctionalComponent<SVGAttributes>;
  class: string[];
  ariaLabel: string;
}

const visual = computed((): StateGlyph => {
  const state = displayClaudeState(props.row.status);
  if (state !== undefined) {
    const live = CLAUDE_STATE_VISUAL[state];
    return {
      icon: live.icon,
      class: [live.color, live.animate ?? ""],
      ariaLabel: live.ariaLabel,
    };
  }
  // muted (gray-9) は選択行の bg-selection 上で contrast 約 3.0:1 まで落ちるため、
  // 選択行にも載るセルは foreground-low (約 5.3:1) を下限にする
  return {
    icon: IDLE_VISUAL.icon,
    class: ["text-foreground-low"],
    ariaLabel: IDLE_VISUAL.ariaLabel,
  };
});

const age = computed(() => {
  const lastActivity = props.row.lastActivity;
  return lastActivity === undefined
    ? undefined
    : formatRelativeAge(Math.floor(lastActivity / 1000));
});
</script>

<template>
  <!-- col-start-2: 先頭の gutter トラックを飛ばして配置する (カラム定義は DashboardDialog) -->
  <span class="col-start-2 grid place-items-center">
    <component
      :is="visual.icon"
      class="size-4"
      :class="visual.class"
      role="img"
      :aria-label="visual.ariaLabel"
    />
  </span>
  <span class="truncate">{{ row.title }}</span>
  <span class="flex items-center gap-1.5 truncate">
    <RepoIcon :name="row.repoName" :owner="row.owner" />
    <span class="truncate text-foreground-low">{{ row.repoName }}</span>
  </span>
  <span class="truncate text-primary-text">{{ row.branch }}</span>
  <span v-if="age" class="truncate text-right tabular-nums" :class="age.color">{{ age.text }}</span>
  <span v-else></span>
</template>
