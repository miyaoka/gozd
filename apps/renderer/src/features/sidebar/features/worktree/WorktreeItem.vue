<doc lang="md">
サイドバーの worktree 1行分。アイコン、表示名、Claude 状態バッジ、変更ファイル数、メッセージ吹き出しを表示する。

## Claude メッセージ吹き出し

done / asking 時に Claude のメッセージ一行目を吹き出しで表示する。
worktree 行の下に吹き出し風のテキストとして出す。
</doc>

<script setup lang="ts">
import type { WorktreeEntry } from "@gozd/rpc";
import { computed } from "vue";
import type { ClaudeState, ClaudeStatus } from "../../../terminal";
import { computeStatusIcons, StatusIcons } from "../../../worktree";
import { hasChanges, worktreeDisplayName } from "../../utils";

/** Claude 状態の表示優先度（高い方が優先） */
const CLAUDE_STATE_PRIORITY: Record<ClaudeState, number> = {
  asking: 3,
  working: 2,
  done: 1,
  idle: 0,
};

/** Claude 状態バッジの設定 */
const CLAUDE_STATE_BADGE: Record<ClaudeState, { icon: string; color: string; animate?: string }> = {
  idle: {
    icon: "icon-[lucide--circle-dot]",
    color: "text-zinc-500",
  },
  working: {
    icon: "icon-[lucide--loader]",
    color: "text-yellow-400",
    animate: "animate-spin",
  },
  asking: {
    icon: "icon-[lucide--message-circle-warning]",
    color: "text-orange-400",
    animate: "animate-bounce",
  },
  done: {
    icon: "icon-[lucide--circle-check]",
    color: "text-green-400",
    animate: "animate-bounce",
  },
};

const props = defineProps<{
  wt: WorktreeEntry;
  active: boolean;
  claudeStatuses: ClaudeStatus[];
  now: number;
  anchorName: string;
  /** Ctrl キー押下中か（番号バッジの表示制御用） */
  ctrlPressed: boolean;
  /** worktree リスト内のインデックス（Ctrl 番号バッジの表示用） */
  index: number;
}>();

const emit = defineEmits<{
  select: [wt: WorktreeEntry];
  openMenu: [anchorName: string, wt: WorktreeEntry];
}>();

/** 経過ミリ秒を "m:ss" 形式に変換 */
function formatElapsed(startedAt: number, now: number): string {
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 優先度順にソートした Claude 状態バッジ一覧 */
const sortedStatuses = computed(() =>
  [...props.claudeStatuses].sort(
    (a, b) => CLAUDE_STATE_PRIORITY[b.state] - CLAUDE_STATE_PRIORITY[a.state],
  ),
);

/** マークダウン記法を除去してテキストの一行目を取得する */
function extractFirstLine(message: string): string {
  for (const line of message.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    return trimmed.replace(/[*_`#]/g, "");
  }
  return "";
}

/** AskUserQuestion の tool_input から質問テキストを抽出する */
function extractAskQuestion(toolInput: Record<string, unknown>): string | undefined {
  if (!Array.isArray(toolInput.questions)) return undefined;
  const [first] = toolInput.questions;
  if (typeof first === "object" && first !== null && typeof first.question === "string") {
    return first.question;
  }
  return undefined;
}

/** asking 時の表示テキスト: AskUserQuestion なら質問内容、それ以外はツール名 */
function extractAskingText(status: ClaudeStatus & { state: "asking" }): string | undefined {
  if (status.toolName === "AskUserQuestion" && status.toolInput) {
    return extractAskQuestion(status.toolInput);
  }
  return status.toolName;
}

/** done/asking の最優先ステータスから吹き出しテキストを取得 */
const bubbleText = computed(() => {
  const [first] = sortedStatuses.value;
  if (first === undefined) return undefined;
  if (first.state === "done" && first.message) {
    return extractFirstLine(first.message);
  }
  if (first.state === "asking") {
    return extractAskingText(first);
  }
  return undefined;
});

/** 吹き出しの色（状態に連動） */
const bubbleColorClass = computed(() => {
  const [first] = sortedStatuses.value;
  if (first === undefined) return "";
  if (first.state === "done") return "text-green-400/70";
  if (first.state === "asking") return "text-orange-400/70";
  return "";
});

/** 変更をアイコン付きカウントに変換 */
const statusIcons = computed(() => {
  if (!props.wt.gitStatuses) return [];
  return computeStatusIcons(props.wt.gitStatuses);
});
</script>

<template>
  <div>
    <!-- 擬似要素パターン: button の ::after で親全体をクリック可能にし、⋮ は z-index で上に出す -->
    <div
      class="group/wt relative grid py-1.5 pl-2"
      :class="active ? 'rounded-md outline outline-blue-400' : 'hover:bg-zinc-800'"
    >
      <!-- Ctrl 押下時の番号バッジ（左上に表示。9 個まで） -->
      <span
        v-if="ctrlPressed && index + 1 <= 9"
        class="absolute -top-1 -left-1 z-20 grid size-4 place-items-center rounded-md bg-green-400 text-[10px] leading-none font-bold text-zinc-900"
      >
        {{ index + 1 }}
      </span>
      <!-- Claude 状態バッジ（右上に重ねて表示） -->
      <div
        v-if="sortedStatuses.length > 0"
        class="pointer-events-none absolute -top-1 -right-1 z-20 flex items-center gap-1"
      >
        <template v-for="(status, si) in sortedStatuses" :key="si">
          <span
            v-if="status.state === 'working'"
            class="text-[10px] leading-none tabular-nums"
            :class="CLAUDE_STATE_BADGE[status.state].color"
          >
            {{ formatElapsed(status.startedAt, now) }}
          </span>
          <span
            class="size-5"
            :class="[
              CLAUDE_STATE_BADGE[status.state].icon,
              CLAUDE_STATE_BADGE[status.state].color,
              CLAUDE_STATE_BADGE[status.state].animate,
            ]"
            :title="status.state"
          />
        </template>
      </div>
      <!-- メインアクション: ::after で親全体に広がるクリック領域 -->
      <button
        class="text-left text-sm text-zinc-200 after:absolute after:inset-0"
        @click="emit('select', wt)"
      >
        <span class="line-clamp-2">{{ worktreeDisplayName(wt) }}</span>
      </button>
      <!-- ⋮ メニューボタン: z-10 で擬似要素の上に出す -->
      <button
        aria-label="Menu"
        class="absolute top-1 right-0 z-10 grid size-6 place-items-center rounded-sm bg-zinc-800 text-zinc-400 opacity-0 shadow-sm transition-opacity group-focus-within/wt:opacity-100 group-hover/wt:opacity-100 hover:text-zinc-200"
        :style="{ anchorName }"
        @click="emit('openMenu', anchorName, wt)"
      >
        <span class="icon-[lucide--ellipsis-vertical] text-sm" />
      </button>
      <span
        v-if="wt.gitStatuses && hasChanges(wt.gitStatuses)"
        class="flex min-h-5 items-center gap-1 text-xs"
      >
        <StatusIcons :entries="statusIcons" />
      </span>
    </div>

    <!-- Claude メッセージ吹き出し -->
    <div
      v-if="bubbleText"
      class="mx-2 mb-1 truncate rounded-sm px-2 py-0.5 text-xs"
      :class="bubbleColorClass"
      :title="bubbleText"
    >
      {{ bubbleText }}
    </div>
  </div>
</template>
