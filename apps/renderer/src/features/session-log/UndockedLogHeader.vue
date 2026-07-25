<doc lang="md">
undock されたセッションログのヘッダ内容 (TerminalLeafTitle と同じ repo + session タイトルの
2 段構成)。repo 未解決 (空文字) は上段ごと省く。

in-app パネルと昇格後の OS ウィンドウの両 presentation から同じ内容を描くために切り出している
(UndockedWindow の header slot に差し込む)。昇格時の総サイズ換算は「両 presentation の
ヘッダが同じ高さになる」ことを前提にするため、内容の SSOT を 1 つに保つ必要がある。
ヘッダの枠 (border / bg / ドラッグ判定) はシェルの責務で、ここには持たない。
</doc>

<script setup lang="ts">
import { RepoIcon } from "../repo-icon";
import type { UndockedLog } from "./useUndockedLog";

interface Props {
  log: UndockedLog;
}

defineProps<Props>();
</script>

<template>
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
