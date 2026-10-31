<script setup lang="ts">
import { computed } from "vue";
import { sessionDisplayTitle, useRepoStore } from "../../shared/repo";
import { RepoIcon } from "../repo-icon";
import { CLAUDE_STATE_VISUAL, stripClaudeTitlePrefix } from "./claudeStatus";
import { useTerminalStore } from "./useTerminalStore";

const props = defineProps<{ dir: string; leafId: string }>();
const terminalStore = useTerminalStore();
const repoStore = useRepoStore();

/** Claude セッションが attach されているか。undefined = 素の PTY（何も出さない） */
const claudeState = computed(() => terminalStore.getClaudeState(props.leafId));

/** サイドバー SessionRow と同一の status 視覚定義 */
const visual = computed(() =>
  claudeState.value === undefined ? undefined : CLAUDE_STATE_VISUAL[claudeState.value],
);

/** dir が属する repo。起動直後の未登録時は undefined */
const repo = computed(() => repoStore.findRepoOwning(props.dir));
const repoName = computed(() => repo.value?.repoName ?? "");
/** GitHub owner。undefined は解決中（RepoIcon が空プレースホルダーを出す） */
const repoOwner = computed(() => repo.value?.githubIdentity?.owner);

/** 端末タイトル → セッション一覧のタイトル の順で解決した表示タイトル */
const title = computed<string>(() => {
  const terminalTitle = stripClaudeTitlePrefix(terminalStore.titleByLeafId[props.leafId] ?? "");
  const ptyId = terminalStore.getPtyId(props.leafId);
  const sessionId = ptyId === undefined ? undefined : terminalStore.getSessionIdByPtyId(ptyId);
  const listTitle = sessionId === undefined ? undefined : repoStore.findSession(sessionId)?.title;
  return sessionDisplayTitle(listTitle, terminalTitle);
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
    <!-- 下段: status アイコン + セッションタイトル -->
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
