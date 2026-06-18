<doc lang="md">
leaf 上部のタイトル行。Claude セッションが attach された leaf だけ status アイコン +
task タイトルを出す。素の PTY (Claude なし) では何も描画しない。

サイドバー TaskRow の行と**同一の構造 / 見た目**にする。status アイコン (形 / 色 / glow /
animate / aria-label) は `CLAUDE_STATE_VISUAL`、タイトル文字列は `taskDisplayTitle` を
SSOT として共有する。線上に重ねず、ターミナル本体の上に通常フローの行として並べる。

## task タイトルの解決

leaf → ptyId → sessionId → Task の経路で引く。session 確立直後など Task がまだ
`WorktreeEntry.tasks` に現れていない窓では title を省き、status アイコンのみ出す。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { taskDisplayTitle, useRepoStore } from "../../shared/repo";
import { CLAUDE_STATE_VISUAL } from "./claudeStatus";
import { useTerminalStore } from "./useTerminalStore";

const props = defineProps<{ leafId: string }>();
const terminalStore = useTerminalStore();
const repoStore = useRepoStore();

/** Claude セッションが attach されているか。undefined = 素の PTY（何も出さない） */
const claudeState = computed(() => terminalStore.getClaudeState(props.leafId));

/** サイドバー TaskRow と同一の status 視覚定義 */
const visual = computed(() =>
  claudeState.value === undefined ? undefined : CLAUDE_STATE_VISUAL[claudeState.value],
);

/** leaf → ptyId → sessionId → Task → 表示タイトル。Task 未到達時は undefined */
const title = computed<string | undefined>(() => {
  const ptyId = terminalStore.getPtyId(props.leafId);
  if (ptyId === undefined) return undefined;
  const sessionId = terminalStore.getSessionIdByPtyId(ptyId);
  if (sessionId === undefined) return undefined;
  const task = repoStore.findTaskBySessionId(sessionId);
  return task === undefined ? undefined : taskDisplayTitle(task);
});
</script>

<template>
  <div
    v-if="visual"
    class="relative flex shrink-0 items-center gap-2 border-b border-border-subtle px-2 py-1"
  >
    <span class="flex w-5 shrink-0 flex-col items-center gap-0.5">
      <component
        :is="visual.icon"
        class="size-4"
        :class="[visual.color, visual.animate]"
        role="img"
        :aria-label="visual.ariaLabel"
      />
    </span>
    <span class="line-clamp-2 flex-1 text-sm break-all" :title="title">{{ title }}</span>
    <span v-if="visual.progress" class="_fx-progress-line" aria-hidden="true"></span>
  </div>
</template>
