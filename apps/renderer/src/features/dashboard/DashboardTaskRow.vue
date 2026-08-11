<doc lang="md">
ダッシュボードの 1 行分のセル群。状態 glyph・タイトル・repo (アイコン付き)・ブランチ・
相対時刻を並べる (grid のカラム定義は DashboardDialog 側の container が持つ。
revive picker と同じ分業)。

## 状態列は全行が glyph を持つ

空白のセルは「状態なし」ではなく情報の欠落に見える (Carbon status indicator パターン /
VS Code agent view はどの状態にも glyph を割り当てる)。live な Claude 状態は
CLAUDE_STATE_VISUAL (色つき = high/medium attention)、live でない task 状態は
muted 単色 + 形の違いで low attention に落とす。状態の判定分類 (sessionId 空 /
closedByUser) はサイドバー TaskRow と同じ。

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
import IconLucideCircleDashed from "~icons/lucide/circle-dashed";

const props = defineProps<{
  row: DashboardRow;
}>();

type TaskStateKind = "not-started" | "stopped";

/**
 * live でない task 状態の low-attention glyph。色は muted 固定で、circle ファミリーの
 * 内部の描き分けだけで状態を区別する (GitHub octicons: draft = 破線サークル、
 * Linear: todo = outline サークル、と同一表現)。square 系は選択コントロール
 * (チェックボックス) の予約語彙なので状態表示に使わない。
 *
 * resumable / closed (closedByUser) はクリック挙動が同一 (resume) でサイドバーも表示区別
 * しないため、UI 上は stopped 1 種に畳む。区別するのは挙動が違う not-started
 * (クリックで新規起動) だけ。
 */
const TASK_STATE_VISUAL: Record<
  TaskStateKind,
  { icon: FunctionalComponent<SVGAttributes>; ariaLabel: string }
> = {
  "not-started": { icon: IconLucideCircleDashed, ariaLabel: "Not started" },
  stopped: { icon: IconLucideCircle, ariaLabel: "Stopped" },
};

function taskStateKind(row: DashboardRow): TaskStateKind {
  if (row.task.sessionId === "") return "not-started";
  return "stopped";
}

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
  // muted (gray-9) は選択行の bg-selection 上で contrast 約 2.5:1 まで落ちるため、
  // 選択行にも載るセルは foreground-low (約 4.4:1) を下限にする
  const idle = TASK_STATE_VISUAL[taskStateKind(props.row)];
  return { icon: idle.icon, class: ["text-foreground-low"], ariaLabel: idle.ariaLabel };
});

const age = computed(() => {
  const baseTime = props.row.baseTime;
  return baseTime === undefined ? undefined : formatRelativeAge(Math.floor(baseTime / 1000));
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
