<doc lang="md">
1 Claude セッションを表すサイドバーの行。Claude state アイコンと相対時刻、タイトル、bubble、
hover で表示される ⋮ メニューボタンを表示する。

## 左端カラム（アイコン / 相対時刻）

左端は固定幅のカラム。端末が開いているセッションは Claude state アイコンを、開いていない
セッションは最終更新からの相対時刻を出す。

端末が開いているセッションの相対時刻は、利用側が求めたときだけアイコンの下に重ねて出す
（状態別の一覧）。実行中は常に「今」なので出さない。基準は状態で変わり、要対応は承認を
待ち始めた時刻、完了と待機は最後に応答を終えた時刻。

アイコンは WCAG 1.4.1 準拠で色 + 形 + aria-label の 3 軸で状態を表現する。アニメーションは
spin / pulse のみ（bounce は notification spam に見えるため不採用）。相対時刻の色は
ダッシュボードと同じ age-* の鮮度スケール。

## 吹き出し (bubble)

done / asking のメッセージは行の上に absolute overlay の漫画吹き出し（角丸 + 下向き尻尾）で出す。
in-flow で行の下に置くと status 変化のたびに後続行が上下に動くため、layout に影響しない
overlay にする。

- 被さる先は DOM 上の前要素（前の行 / wt header）。positioned 要素は DOM 順で後が上に
  描画されるため z-index なしで手前に出る
- `pointer-events-none` で下の行のクリックを遮らない（代償として hover tooltip は持てない）
- 尻尾は rotate-45 の正方形に border-r/b のみ付ける技法。ひし形の上半分が吹き出し本体の下辺
  border を覆い、境界が繋がって見える
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { RepoIcon } from "../../../repo-icon";
import type { SessionRow } from "../../../session";
import { CLAUDE_STATE_VISUAL, displayClaudeState, type ClaudeState } from "../../../terminal";
import { extractAskingText, extractFirstSentence } from "../../../voicevox";
import { useRelativeTime } from "../../useRelativeTime";
import IconLucideEllipsisVertical from "~icons/lucide/ellipsis-vertical";

const props = defineProps<{
  row: SessionRow;
  active: boolean;
  /** 行がどの repo のものか。repo をまたいで平らに並べる一覧だけが渡し、タイトルの下に小さく出す */
  repo?: { name: string; owner: string | undefined };
  /** 端末が開いている行でも、状態アイコンの下に経過時間を出す（実行中を除く） */
  showLiveAge?: boolean;
}>();

const emit = defineEmits<{
  select: [row: SessionRow];
  openMenu: [anchorEl: HTMLElement, row: SessionRow];
}>();

/** 端末が開いていて Claude state が取れているときだけアイコンを出す。
 * done + pendingWork は working として描画する（displayClaudeState） */
const visual = computed(() => {
  const state = displayClaudeState(props.row.status);
  return state === undefined ? undefined : CLAUDE_STATE_VISUAL[state];
});

/**
 * 端末が開いている行の経過時間の基準。要対応は承認を待ち始めた時刻、完了と待機は最後に応答を
 * 終えた時刻。実行中は常に「今」なので出さない
 */
const LIVE_AGE_BASE: Record<ClaudeState, ((row: SessionRow) => number | undefined) | undefined> = {
  asking: (row) => row.stateSince,
  done: (row) => row.lastActivity,
  idle: (row) => row.lastActivity,
  working: undefined,
};

const ageBase = computed(() => {
  const row = props.row;
  if (!row.live) return row.lastActivity;
  if (props.showLiveAge !== true) return undefined;
  const state = displayClaudeState(row.status);
  return state === undefined ? undefined : LIVE_AGE_BASE[state]?.(row);
});

const relativeTime = useRelativeTime(ageBase);

// 吹き出しの intent は border 色だけで識別する。地は白 (bg-foreground) + 黒文字
// (text-background) の反転ペアで、intent の *-text token (dark 地用の step 11) は
// 白地では contrast が保証されないため文字色には使わない
const BUBBLE_INTENT_CLASS = {
  done: "border-success",
  asking: "border-warning-strong",
} as const;

// 吹き出しの表示判定 SSOT。intent (色) と text を単一 computed で導出し、
// done/asking 判定が複数 computed に分散してドリフトするのを防ぐ。
// done は displayClaudeState を SSOT に判定する（pendingWork 中の done は working に
// 倒れ吹き出しを出さない）。state === "done" の併記は union narrowing のためで、
// displayClaudeState === "done" と常に同値。
const bubble = computed<{ intent: keyof typeof BUBBLE_INTENT_CLASS; text: string } | undefined>(
  () => {
    const status = props.row.status;
    if (status === undefined) return undefined;
    // text の空文字は「表示するものが無い」と同義。undefined と併せて弾かないと
    // テキスト無しの空吹き出し（枠 + 尻尾のみ）が描画される
    if (status.state === "done" && displayClaudeState(status) === "done" && status.message) {
      const text = extractFirstSentence(status.message);
      return text === undefined || text === "" ? undefined : { intent: "done", text };
    }
    if (status.state === "asking") {
      const text = extractAskingText(status.toolName, status.toolInput);
      return text === undefined || text === "" ? undefined : { intent: "asking", text };
    }
    return undefined;
  },
);

const bubbleClass = computed(() =>
  bubble.value === undefined ? "" : BUBBLE_INTENT_CLASS[bubble.value.intent],
);

function onMenuClick(event: MouseEvent) {
  event.stopPropagation();
  const target = event.currentTarget;
  if (target instanceof HTMLElement) emit("openMenu", target, props.row);
}
</script>

<template>
  <div class="group/session relative">
    <button
      type="button"
      :data-active="active"
      class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-element-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden focus-visible:ring-inset data-[active=true]:bg-primary-subtle data-[active=true]:hover:bg-primary-subtle-hover"
      @click="emit('select', row)"
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
        <span
          v-if="relativeTime.text !== ''"
          class="text-[10px] tabular-nums"
          :class="relativeTime.color"
          >{{ relativeTime.text }}</span
        >
      </span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="line-clamp-2 text-sm break-all" :title="row.title">{{ row.title }}</span>
        <span v-if="repo" class="flex min-w-0 items-center gap-1 text-xs text-foreground-low">
          <RepoIcon :name="repo.name" :owner="repo.owner" size="sm" />
          <span class="truncate">{{ repo.name }}</span>
        </span>
      </span>
    </button>
    <span v-if="visual?.progress" class="_fx-progress-line" aria-hidden="true"></span>
    <button
      type="button"
      aria-label="Open session menu"
      class="absolute inset-y-0 right-1 my-auto grid size-5 place-items-center rounded-sm bg-panel text-foreground opacity-0 shadow-md ring-1 ring-border transition-opacity duration-100 group-focus-within/session:opacity-100 group-hover/session:opacity-100 hover:bg-element hover:text-foreground"
      @click="onMenuClick"
    >
      <IconLucideEllipsisVertical class="text-xs" />
    </button>
    <p
      v-if="bubble"
      class="pointer-events-none absolute bottom-full left-1 mb-1.5 w-max max-w-[calc(100%-0.5rem)] rounded-xl border bg-foreground px-2 py-0.5 text-xs text-background shadow-md"
      :class="bubbleClass"
    >
      <span class="line-clamp-1">{{ bubble.text }}</span>
      <span
        class="absolute -bottom-1 left-3 size-2 rotate-45 border-r border-b border-inherit bg-foreground"
        aria-hidden="true"
      ></span>
    </p>
  </div>
</template>
