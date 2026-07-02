<doc lang="md">
1 task を表すサイドバーカード内の行。Claude state アイコン、タイトル、相対時刻、bubble、
hover で表示される ⋮ メニューボタンを表示する。

タイトル編集は ⋮ メニューの Edit title 経由 (`TaskMenu` → `useTaskEditing.open`) で
TaskEditDialog を開く。行内に inline 編集は持たない。

## state アイコン

Claude state 由来 (idle / working / asking / done) のときだけアイコンを表示する。
WCAG 1.4.1 準拠で色 + 形 + aria-label の 3 軸で状態を表現する。アニメーションは spin / pulse のみ
（bounce は notification spam に見えるため不採用）。

resumable / closed / not-started は task 専用の状態でアイコンを出さない。クリック挙動だけが意味を持つ:

- `not-started`: PR/issue picker や手動作成で生まれただけで Claude session が未 attach の task。
  クリックすると素の `claude` が起動して SessionStart hook で attach される。
- `resumable`: 過去に session を持っていた (task.sessionId 非空) が live PTY に未接続。
  app close (renderer 強制終了) で中断されたケース。クリックすると `claude --resume <sessionId>` が起動。
- `closed`: ユーザーが明示的にターミナルを閉じた task (task.closedByUser=true)。
  状態としては resumable と同じく resume 可能。

`resumable` と `closed` の振る舞いは同じ (どちらもクリックで `claude --resume`)。app close (renderer
強制終了) では `detachSession` が呼ばれないため `closedByUser` は false のまま残り、自動的に
`resumable` 側に倒れる。

## 吹き出し (bubble)

done / asking のメッセージは行の上に absolute overlay の漫画吹き出し（角丸 + 下向き尻尾）で出す。
in-flow で行の下に置くと status 変化のたびに後続行が上下に動き、WtCard が並び順固定で守っている
task 行の空間記憶が壊れるため、layout に影響しない overlay にする。

- 被さる先は DOM 上の前要素（前の task 行 / wt header）。positioned 要素は DOM 順で後が上に
  描画されるため z-index なしで手前に出る
- `pointer-events-none` で下の行のクリックを遮らない（代償として hover tooltip は持てない）
- 尻尾は rotate-45 の正方形に border-r/b のみ付ける技法。ひし形の上半分が吹き出し本体の下辺
  border を覆い、境界が繋がって見える

## 左端カラム（アイコン / 相対時刻）

左端は固定幅のカラム。active な task（Claude state あり）はアイコンを、inactive な task
（resumable / closed / not-started = アイコン無し）は相対時刻を排他表示する。両者を同時には出さない。

相対時刻は `taskBaseTime.resolveTaskBaseTime` を SSOT として算出する。表示されるのは status 不在の
inactive state だけなので実質 `task.createdAt` 起点になる（status があれば `lastActivityAt` を使うが、
その state はアイコン表示側に倒れて時刻を出さない）。
</doc>

<script setup lang="ts">
import type { Task } from "@gozd/proto";
import { computed } from "vue";
import { taskDisplayTitle } from "../../../../shared/repo";
import { CLAUDE_STATE_VISUAL, displayClaudeState } from "../../../terminal";
import type { ClaudeState, ClaudeStatus } from "../../../terminal";
import { extractAskingText, extractFirstSentence } from "../../../voicevox";
import { resolveTaskBaseTime } from "../../taskBaseTime";
import { useRelativeTime } from "../../useRelativeTime";
import IconLucideEllipsisVertical from "~icons/lucide/ellipsis-vertical";

type StateKind = ClaudeState | "resumable" | "closed" | "not-started";

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
  // done + pendingWork は working として描画する（displayClaudeState）
  const displayState = displayClaudeState(props.status);
  if (displayState !== undefined) return displayState;
  // status 不在の意味は task の各フラグで分かれる:
  // - sessionId 空: Claude が一度も起動していない (PR/issue picker や手動作成直後 /
  //   resume 失敗で sessionId 空に書き戻された後)
  // - sessionId あり + closedByUser=true: ユーザーが明示的にターミナルを閉じた
  // - sessionId あり + closedByUser=false: app close で中断された (resumable)
  if (props.task.sessionId === "") return "not-started";
  return props.task.closedByUser ? "closed" : "resumable";
});
// claude state (idle/working/asking/done) のみ icon を持つ。resumable/closed/not-started は
// CLAUDE_STATE_VISUAL に entry が無く undefined になり、相対時刻表示側に倒れる。
const visual = computed(() => {
  const kind = stateKind.value;
  return kind in CLAUDE_STATE_VISUAL ? CLAUDE_STATE_VISUAL[kind as ClaudeState] : undefined;
});
const title = computed(() => taskDisplayTitle(props.task));

const baseTime = computed<number | undefined>(() => resolveTaskBaseTime(props.status, props.task));

const relativeTime = useRelativeTime(baseTime);

const bubbleText = computed<string | undefined>(() => {
  const status = props.status;
  if (status === undefined) return undefined;
  // pendingWork でない真の done のみ吹き出しを出す。pending 中は working 描画なので出さない。
  if (status.state === "done" && status.pendingWork !== true && status.message)
    return extractFirstSentence(status.message);
  if (status.state === "asking") return extractAskingText(status.toolName, status.toolInput);
  return undefined;
});

// 吹き出しの intent 色。bg は両状態とも panel（warning-strong-subtle は未定義 / YAGNI のため
// subtle bg には寄せず、ニュートラル地 + intent 輪郭で統一する）
const BUBBLE_INTENT_CLASS = {
  done: "border-success text-success-text",
  asking: "border-warning-strong text-warning-strong-text",
} as const;

const bubbleClass = computed(() => {
  const status = props.status;
  if (displayClaudeState(status) === "done") return BUBBLE_INTENT_CLASS.done;
  if (status?.state === "asking") return BUBBLE_INTENT_CLASS.asking;
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
      <span class="flex w-5 shrink-0 flex-col items-center gap-0.5">
        <component
          :is="visual.icon"
          v-if="visual"
          class="size-4"
          :class="[visual.color, visual.animate]"
          role="img"
          :aria-label="visual.ariaLabel"
        />
        <span v-else class="text-[10px] text-foreground-muted tabular-nums">{{
          relativeTime
        }}</span>
      </span>
      <span class="line-clamp-2 flex-1 text-sm break-all" :title="title">{{ title }}</span>
    </button>
    <span v-if="visual?.progress" class="_fx-progress-line" aria-hidden="true"></span>
    <button
      type="button"
      aria-label="Open task menu"
      class="absolute inset-y-0 right-1 my-auto grid size-5 place-items-center rounded-sm bg-panel text-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity duration-100 group-focus-within/task:opacity-100 group-hover/task:opacity-100 hover:bg-element hover:text-foreground"
      @click="onMenuClick"
    >
      <IconLucideEllipsisVertical class="text-xs" />
    </button>
    <p
      v-if="bubbleText"
      class="pointer-events-none absolute bottom-full left-1 mb-1.5 w-max max-w-[calc(100%-0.5rem)] rounded-xl border bg-panel px-2 py-0.5 text-xs italic shadow-md"
      :class="bubbleClass"
    >
      <span class="line-clamp-1">{{ bubbleText }}</span>
      <span
        class="absolute -bottom-1 left-3 size-2 rotate-45 border-r border-b border-inherit bg-panel"
        aria-hidden="true"
      ></span>
    </p>
  </div>
</template>
