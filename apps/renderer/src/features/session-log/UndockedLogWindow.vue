<doc lang="md">
undock されたセッションログメッセージ 1 件のフローティングウィンドウ。

ドラッグ / リサイズ / クランプ / 初期サイズ換算は汎用シェル FloatingWindow に委譲し、
ここはヘッダ内容 (TerminalLeafTitle と同じ repo + session タイトルの 2 段構成) と
kind 別配色の本文スクロール面だけを担う。
</doc>

<script setup lang="ts">
import { FloatingWindow } from "../floating-window";
import { RepoIcon } from "../repo-icon";
import SessionLogMessageBody from "./SessionLogMessageBody.vue";
import { useUndockedLog, type UndockedLog } from "./useUndockedLog";

interface Props {
  log: UndockedLog;
}

const props = defineProps<Props>();
const { close, move, bringToFront, takeHandoff } = useUndockedLog();

// popover ヘッダのドラッグから undock された場合の引き継ぎ。setup で 1 回だけ消費する
// (undock() → 描画フラッシュ → setup が同期で完結するため、setup 時点で必ず取得できる)。
const handoff = takeHandoff(props.log.id);
</script>

<template>
  <FloatingWindow
    :x="log.x"
    :y="log.y"
    :z="log.z"
    :body-width="log.bodyWidth"
    :body-height="log.bodyHeight"
    :handoff="handoff"
    @move="(x, y) => move(log.id, x, y)"
    @activate="bringToFront(log.id)"
    @close="close(log.id)"
  >
    <!-- TerminalLeafTitle と同じ 2 段構成 (上段: repo アイコン + repo 名 / 下段: session
         タイトル)。repo 未解決 (空文字) は上段ごと省く。 -->
    <template #header>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div v-if="log.repoName !== ''" class="flex items-center gap-2">
          <RepoIcon :name="log.repoName" :owner="log.repoOwner" />
          <span class="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide">
            {{ log.repoName }}
          </span>
        </div>
        <h2 class="truncate text-xs text-foreground-low" :title="log.title">
          {{ log.title }}
        </h2>
      </div>
    </template>

    <div
      class="min-h-0 flex-1 overflow-auto select-text"
      :class="log.kind === 'assistant' ? 'bg-chat-incoming' : 'bg-chat-outgoing'"
    >
      <SessionLogMessageBody :kind="log.kind" :text="log.text" />
    </div>
  </FloatingWindow>
</template>
