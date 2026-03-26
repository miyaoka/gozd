<doc lang="md">
Commit detail pane showing metadata for selected commits in the git graph.

## Behavior

- Single selection: shows one commit's full detail
- Range selection (shift+click): shows all commits in the range as a scrollable list
</doc>

<script setup lang="ts">
import type { GitCommit } from "@gozd/rpc";
import { UNCOMMITTED_HASH } from "@gozd/rpc";

interface Props {
  /** 表示対象のコミット配列 */
  commits: GitCommit[];
}

defineProps<Props>();

function isUncommitted(hash: string): boolean {
  return hash === UNCOMMITTED_HASH;
}

/** 日付フォーマット（詳細形式） */
function formatDetailDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
</script>

<template>
  <div
    class="flex size-full flex-col overflow-y-auto bg-zinc-900 text-xs text-zinc-300 select-text"
  >
    <!-- No selection -->
    <div v-if="commits.length === 0" class="p-3 text-zinc-500">Select a commit to view details</div>

    <!-- Commit list -->
    <div
      v-for="(commit, i) in commits"
      :key="commit.hash"
      class="flex flex-col gap-3 p-3"
      :class="i > 0 ? 'border-t border-zinc-700' : ''"
    >
      <!-- Uncommitted -->
      <div v-if="isUncommitted(commit.hash)" class="text-zinc-400 italic">Uncommitted Changes</div>

      <!-- Normal commit -->
      <template v-else>
        <!-- Subject -->
        <div class="text-sm font-semibold text-zinc-200">
          {{ commit.message }}
        </div>

        <!-- Body -->
        <pre v-if="commit.body" class="whitespace-pre-wrap text-zinc-400">{{ commit.body }}</pre>

        <!-- Meta fields -->
        <div class="flex flex-col gap-1.5">
          <!-- Author & Date -->
          <div class="flex items-center gap-2">
            <span class="icon-[lucide--user] size-3.5 shrink-0 text-zinc-500" />
            <span class="text-zinc-200">{{ commit.author }}</span>
            <span class="text-zinc-500">{{ formatDetailDate(commit.date) }}</span>
          </div>

          <!-- Hash -->
          <div class="flex items-center gap-2">
            <span class="icon-[lucide--hash] size-3.5 shrink-0 text-zinc-500" />
            <span class="font-mono text-zinc-400">{{ commit.hash }}</span>
          </div>

          <!-- Parents -->
          <div v-if="commit.parents.length > 0" class="flex items-start gap-2">
            <span class="icon-[lucide--git-commit-horizontal] size-3.5 shrink-0 text-zinc-500" />
            <div class="flex flex-col gap-0.5">
              <span v-for="parent in commit.parents" :key="parent" class="font-mono text-zinc-400">
                {{ parent.slice(0, 7) }}
              </span>
            </div>
          </div>

          <!-- Refs -->
          <div v-if="commit.refs.length > 0" class="flex items-start gap-2">
            <span class="icon-[lucide--tag] size-3.5 shrink-0 text-zinc-500" />
            <div class="flex flex-wrap gap-1">
              <span
                v-for="r in commit.refs"
                :key="r"
                class="rounded-sm bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-300"
              >
                {{ r }}
              </span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
