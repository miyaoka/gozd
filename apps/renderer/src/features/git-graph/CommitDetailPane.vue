<doc lang="md">
Commit detail pane showing metadata for selected commits in the git graph.

## Behavior

- Single selection: shows one commit's full detail
- Range selection (shift+click): shows all commits in the range as a scrollable list
</doc>

<script setup lang="ts">
import type { GitCommit } from "@gozd/proto";
import { computed } from "vue";
import { UNCOMMITTED_HASH } from "../worktree";
import CommitSegmentList from "./CommitSegmentList";
import { linkifyCommitMessage } from "./linkifyCommitMessage";

interface Props {
  /** 表示対象のコミット配列 */
  commits: GitCommit[];
  /** GitHub repo base URL。`#番号` を issue/PR リンクに変換するのに使う */
  baseUrl: string | undefined;
}

const props = defineProps<Props>();

/** subject / body の linkify 結果を `(commits, baseUrl)` が変わったときだけ再計算する。
 * template から関数呼び出しすると毎 render で `linkifyCommitMessage` (string.matchAll の O(n))
 * が走るので、`commits.length` × `(message + body)` の再計算を抑える。 */
const subjectSegmentsList = computed(() =>
  props.commits.map((c) => linkifyCommitMessage(c.message, props.baseUrl)),
);
const bodySegmentsList = computed(() =>
  props.commits.map((c) => linkifyCommitMessage(c.body, props.baseUrl)),
);

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
    class="flex size-full flex-col overflow-y-auto bg-background text-xs text-foreground select-text"
  >
    <!-- No selection -->
    <div v-if="commits.length === 0" class="p-3 text-foreground-subtle">
      Select a commit to view details
    </div>

    <!-- Commit list -->
    <div
      v-for="(commit, i) in commits"
      :key="commit.hash"
      class="flex flex-col gap-3 p-3"
      :class="i > 0 ? 'border-t border-border' : ''"
    >
      <!-- Uncommitted -->
      <div v-if="isUncommitted(commit.hash)" class="text-foreground-muted italic">
        Uncommitted Changes
      </div>

      <!-- Normal commit -->
      <template v-else>
        <!-- Subject -->
        <div class="text-sm font-semibold text-foreground-strong">
          <CommitSegmentList :segments="subjectSegmentsList[i]" />
        </div>

        <!-- Body: `<pre>` 配下でも `CommitSegmentList` は render function 実装のため
             template 改行由来の whitespace text node 混入が構造的に起きない。 -->
        <pre v-if="commit.body" class="whitespace-pre-wrap text-foreground-muted"><CommitSegmentList
          :segments="bodySegmentsList[i]"
        /></pre>

        <!-- Meta fields -->
        <div class="flex flex-col gap-1.5">
          <!-- Author & Date -->
          <div class="flex items-center gap-2">
            <span class="icon-[lucide--user] size-3.5 shrink-0 text-foreground-subtle" />
            <span class="text-foreground-strong">{{ commit.author }}</span>
            <span class="text-foreground-subtle">{{ formatDetailDate(commit.date) }}</span>
          </div>

          <!-- Hash -->
          <div class="flex items-center gap-2">
            <span class="icon-[lucide--hash] size-3.5 shrink-0 text-foreground-subtle" />
            <span class="font-mono text-foreground-muted">{{ commit.hash }}</span>
          </div>

          <!-- Parents -->
          <div v-if="commit.parents.length > 0" class="flex items-start gap-2">
            <span
              class="icon-[lucide--git-commit-horizontal] size-3.5 shrink-0 text-foreground-subtle"
            />
            <div class="flex flex-col gap-0.5">
              <span
                v-for="parent in commit.parents"
                :key="parent"
                class="font-mono text-foreground-muted"
              >
                {{ parent.slice(0, 7) }}
              </span>
            </div>
          </div>

          <!-- Refs -->
          <div v-if="commit.refs.length > 0" class="flex items-start gap-2">
            <span class="icon-[lucide--tag] size-3.5 shrink-0 text-foreground-subtle" />
            <div class="flex flex-wrap gap-1">
              <span
                v-for="r in commit.refs"
                :key="r"
                class="rounded-sm bg-surface-1 px-1 py-0.5 text-[10px] text-foreground"
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
