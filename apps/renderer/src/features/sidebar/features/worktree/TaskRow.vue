<doc lang="md">
1 task を表すサイドバーカード内の行。Claude state アイコン、タイトル、相対時刻、bubble、
hover で表示される ⋮ メニューボタンを表示する。

タイトル編集は ⋮ メニューの Edit title 経由 (`TaskMenu` → `useTaskEditing.open`) で
TaskEditDialog を開く。行内に inline 編集は持たない。

## state アイコン

WCAG 1.4.1 準拠で色 + 形 + aria-label の 3 軸で状態を表現する。アニメーションは spin / pulse のみ
（bounce は notification spam に見えるため不採用）。

- `not-started`: PR/issue picker や手動作成で生まれただけで Claude session が未 attach の task。
  クリックすると素の `claude` が起動して SessionStart hook で attach される。
- `resumable`: 過去に session を持っていた (task.sessionId 非空) が live PTY に未接続。
  app close (renderer 強制終了) で中断されたケース。クリックすると `claude --resume <sessionId>` が起動。
- `closed`: ユーザーが明示的にターミナルを閉じた task (task.closedByUser=true)。
  状態としては resumable と同じく resume 可能だが、`eye-closed` アイコンで「ユーザーが終わらせた」
  感を出して区別する。クリック挙動は resumable と同じ。

`resumable` と `closed` の振る舞いは同じ (どちらもクリックで `claude --resume`) で、UI 上の
意味的区別だけを行う。app close (renderer 強制終了) では `detachSession` が呼ばれないため
`closedByUser` は false のまま残り、自動的に `resumable` 側に倒れる。

## 相対時刻の起点

`status.lastActivityAt`（Claude が最後に動いた時刻）を全 state で使う。state 遷移時刻ではなく
活動時刻を基準にすることで、working → idle / asking などで "now" にリセットされない。
status 不在（resumable / closed）時は `task.createdAt` にフォールバックする。算出ロジックは
`taskBaseTime.resolveTaskBaseTime` を SSOT として使う。
</doc>

<script setup lang="ts">
import type { Task } from "@gozd/proto";
import { computed, type FunctionalComponent, type SVGAttributes } from "vue";
import { CLAUDE_STATE_ICON } from "../../../terminal";
import type { ClaudeStatus } from "../../../terminal";
import { extractAskingText, extractFirstSentence } from "../../../voicevox";
import { resolveTaskBaseTime } from "../../taskBaseTime";
import { useRelativeTime } from "../../useRelativeTime";
import { taskDisplayTitle } from "../../utils";
import IconLucideCircleDashed from "~icons/lucide/circle-dashed";
import IconLucideEllipsisVertical from "~icons/lucide/ellipsis-vertical";
import IconLucideEyeClosed from "~icons/lucide/eye-closed";
import IconLucideSquarePlay from "~icons/lucide/square-play";

type StateKind = "asking" | "working" | "done" | "idle" | "resumable" | "closed" | "not-started";

/**
 * Claude state 由来 (idle / working / asking / done) のアイコンは
 * `CLAUDE_STATE_ICON` を SSOT として参照し、TerminalLeaf と形を揃える。
 * 色 / aria-label / 追加アニメーション (asking の pulse) は表示文脈で変わるため
 * サイドバー側でラップする。resumable / closed / not-started は task 専用の状態。
 */
const STATE_VISUAL: Record<
  StateKind,
  { icon: FunctionalComponent<SVGAttributes>; color: string; animate?: string; ariaLabel: string }
> = {
  asking: {
    ...CLAUDE_STATE_ICON.asking,
    color: "text-warning-strong-text _fx-glow-alert",
    animate: "animate-pulse",
    ariaLabel: "Awaiting permission",
  },
  working: {
    ...CLAUDE_STATE_ICON.working,
    color: "text-warning-text _fx-glow-warning",
    ariaLabel: "Working",
  },
  done: {
    ...CLAUDE_STATE_ICON.done,
    color: "text-success-text _fx-glow-success",
    ariaLabel: "Done",
  },
  idle: {
    ...CLAUDE_STATE_ICON.idle,
    color: "text-foreground-low",
    ariaLabel: "Idle",
  },
  resumable: {
    icon: IconLucideSquarePlay,
    color: "text-foreground-muted",
    ariaLabel: "Resumable",
  },
  closed: {
    icon: IconLucideEyeClosed,
    color: "text-foreground-muted",
    ariaLabel: "Closed by user",
  },
  "not-started": {
    icon: IconLucideCircleDashed,
    color: "text-foreground-muted",
    ariaLabel: "Not started",
  },
};

const props = defineProps<{
  task: Task;
  status: ClaudeStatus | undefined;
  active: boolean;
}>();

const emit = defineEmits<{
  select: [task: Task];
  openMenu: [anchorEl: HTMLElement, task: Task];
}>();

const stateKind = computed<StateKind>(() => {
  if (props.status) return props.status.state;
  // status 不在の意味は task の各フラグで分かれる:
  // - sessionId 空: Claude が一度も起動していない (PR/issue picker や手動作成直後 /
  //   resume 失敗で sessionId 空に書き戻された後)
  // - sessionId あり + closedByUser=true: ユーザーが明示的にターミナルを閉じた
  // - sessionId あり + closedByUser=false: app close で中断された (resumable)
  if (props.task.sessionId === "") return "not-started";
  return props.task.closedByUser ? "closed" : "resumable";
});
const visual = computed(() => STATE_VISUAL[stateKind.value]);
const title = computed(() => taskDisplayTitle(props.task));

const baseTime = computed<number | undefined>(() => resolveTaskBaseTime(props.status, props.task));

const relativeTime = useRelativeTime(baseTime);

const bubbleText = computed<string | undefined>(() => {
  const status = props.status;
  if (status === undefined) return undefined;
  if (status.state === "done" && status.message) return extractFirstSentence(status.message);
  if (status.state === "asking") return extractAskingText(status.toolName, status.toolInput);
  return undefined;
});

const bubbleColorClass = computed(() => {
  const status = props.status;
  if (status?.state === "done") return "text-success-text";
  if (status?.state === "asking") return "text-warning-strong-text";
  return "";
});

function onMenuClick(event: MouseEvent) {
  event.stopPropagation();
  const target = event.currentTarget;
  if (target instanceof HTMLElement) emit("openMenu", target, props.task);
}
</script>

<template>
  <div class="group/task relative">
    <button
      type="button"
      :data-active="active"
      class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-element-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset data-[active=true]:bg-primary-subtle data-[active=true]:hover:bg-primary-subtle-hover"
      @click="emit('select', task)"
    >
      <component
        :is="visual.icon"
        class="size-4 shrink-0"
        :class="[visual.color, visual.animate]"
        role="img"
        :aria-label="visual.ariaLabel"
      />
      <span class="line-clamp-2 flex-1 text-sm break-all" :title="title">{{ title }}</span>
      <span class="text-[10px] text-foreground-muted tabular-nums">{{ relativeTime }}</span>
    </button>
    <span v-if="stateKind === 'working'" class="_fx-progress-line" aria-hidden="true"></span>
    <button
      type="button"
      aria-label="Open task menu"
      class="absolute inset-y-0 right-1 my-auto grid size-5 place-items-center rounded-sm bg-panel text-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity duration-100 group-focus-within/task:opacity-100 group-hover/task:opacity-100 hover:bg-element hover:text-foreground"
      @click="onMenuClick"
    >
      <IconLucideEllipsisVertical class="text-xs" />
    </button>
  </div>
  <p
    v-if="bubbleText"
    class="line-clamp-1 text-xs italic"
    :class="bubbleColorClass"
    :title="bubbleText"
  >
    {{ bubbleText }}
  </p>
</template>
