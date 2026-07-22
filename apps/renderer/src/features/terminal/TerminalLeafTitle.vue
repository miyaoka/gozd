<doc lang="md">
leaf 上部のタイトル行。Claude セッションが attach された leaf だけ描画する
（素の PTY では何も出さない）。2 段構成:

- 上段: repo アイコン + repo 名（サイドバー RepoSection のヘッダと同一の見た目）
- 下段: status アイコン + task タイトル（サイドバー TaskRow と同一の行）

status アイコン (形 / 色 / glow / animate / aria-label) は `CLAUDE_STATE_VISUAL`、
タイトル文字列は `taskDisplayTitle`、repo アイコンは `RepoIcon` を SSOT として共有する。
線上に重ねず、ターミナル本体の上に通常フローの行として並べる。

## task タイトルの解決

leaf → ptyId → sessionId → Task の経路で引く。session 確立直後など Task がまだ
`WorktreeEntry.tasks` に現れていない窓では title を省き、status アイコンのみ出す。

## repo の解決

leaf の `dir`（worktree path）から `findRepoOwning` で所属 repo を逆引きする。
repo 未登録（起動直後など）は 1 段目を省く。
</doc>

<script setup lang="ts">
import { computed } from "vue";
import { taskDisplayTitle, useRepoStore } from "../../shared/repo";
import { RepoIcon } from "../repo-icon";
import { CLAUDE_STATE_VISUAL } from "./claudeStatus";
import { useTerminalStore } from "./useTerminalStore";

const props = defineProps<{ dir: string; leafId: string }>();
const terminalStore = useTerminalStore();
const repoStore = useRepoStore();

/** Claude セッションが attach されているか。undefined = 素の PTY（何も出さない） */
const claudeState = computed(() => terminalStore.getClaudeState(props.leafId));

/** サイドバー TaskRow と同一の status 視覚定義 */
const visual = computed(() =>
  claudeState.value === undefined ? undefined : CLAUDE_STATE_VISUAL[claudeState.value],
);

/** dir が属する repo。起動直後の未登録時は undefined */
const repo = computed(() => repoStore.findRepoOwning(props.dir));
const repoName = computed(() => repo.value?.repoName ?? "");
/** GitHub owner。undefined は解決中（RepoIcon が空プレースホルダーを出す） */
const repoOwner = computed(() => repo.value?.githubIdentity?.owner);

/** leaf → ptyId → sessionId → Task → 表示タイトル。Task 未到達時は undefined */
const title = computed<string | undefined>(() => {
  const ptyId = terminalStore.getPtyId(props.leafId);
  if (ptyId === undefined) return undefined;
  const sessionId = terminalStore.getSessionIdByPtyId(ptyId);
  // 空文字は未起動 / 切り離し済みを意味し、findTaskBySessionId が誤一致しうるため除外する
  if (sessionId === undefined || sessionId === "") return undefined;
  const task = repoStore.findTaskBySessionId(sessionId);
  return task === undefined ? undefined : taskDisplayTitle(task);
});
</script>

<template>
  <div
    v-if="visual"
    class="relative flex shrink-0 flex-col gap-1 border-b border-border-subtle px-2 py-1"
  >
    <!-- 上段: repo アイコン + repo 名（repo 未登録時は省く） -->
    <div v-if="repoName !== ''" class="flex items-center gap-2">
      <RepoIcon :name="repoName" :owner="repoOwner" />
      <span class="min-w-0 flex-1 truncate text-sm font-semibold tracking-wide">
        {{ repoName }}
      </span>
    </div>
    <!-- 下段: status アイコン + task タイトル -->
    <div class="flex items-center gap-2">
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
    </div>
    <span v-if="visual.progress" class="_fx-progress-line" aria-hidden="true"></span>
  </div>
</template>
