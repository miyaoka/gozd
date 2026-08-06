<doc lang="md">
選択されたコミットのメタデータを並べるペイン。

**選択が 1 つか範囲かをこのペインは判断しない**。渡されたコミット列をその順に並べるだけで、
何を選択とみなすかは graph 側が持つ。判断を両側に置くと、選択の意味を変えるたびに描画側も
追う必要が出る。

- コミットメッセージ中の issue / PR 参照はリンクにする。ただし参照先の repo が特定できない
  ときは素のテキストのまま出す。誤った宛先のリンクを作るより、リンクにしないほうがよい
- Working Tree を表す擬似コミットは、まだコミットになっていないため意味のある属性を持たない。
  通常のコミットと同じ枠には収めず、そう分かる 1 行に倒す
</doc>

<script setup lang="ts">
import type { GitCommit } from "@gozd/rpc";
import { computed } from "vue";
import { formatDetailTime } from "../../shared/time";
import { UNCOMMITTED_HASH } from "../worktree";
import CommitSegmentList from "./CommitSegmentList";
import { linkifyCommitMessage } from "./linkifyCommitMessage";
import IconLucideGitCommitHorizontal from "~icons/lucide/git-commit-horizontal";
import IconLucideHash from "~icons/lucide/hash";
import IconLucideTag from "~icons/lucide/tag";
import IconLucideUser from "~icons/lucide/user";

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
</script>

<template>
  <div
    class="flex size-full flex-col overflow-y-auto bg-background text-xs text-foreground select-text"
  >
    <!-- No selection -->
    <div v-if="commits.length === 0" class="p-3 text-foreground-low">
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
      <div v-if="isUncommitted(commit.hash)" class="text-foreground-low italic">
        Uncommitted Changes
      </div>

      <!-- Normal commit -->
      <template v-else>
        <!-- Subject -->
        <div class="text-sm font-semibold text-foreground">
          <CommitSegmentList :segments="subjectSegmentsList[i]" />
        </div>

        <!-- Body: `<pre>` 配下でも `CommitSegmentList` は render function 実装のため
             template 改行由来の whitespace text node 混入が構造的に起きない。 -->
        <pre v-if="commit.body" class="whitespace-pre-wrap text-foreground-low"><CommitSegmentList
          :segments="bodySegmentsList[i]"
        /></pre>

        <!-- Meta fields -->
        <div class="flex flex-col gap-1.5">
          <!-- Author & Date -->
          <div class="flex items-center gap-2">
            <IconLucideUser class="size-3.5 shrink-0 text-foreground-low" />
            <span class="text-foreground">{{ commit.author }}</span>
            <span class="text-foreground-low">{{ formatDetailTime(commit.date) }}</span>
          </div>

          <!-- Hash -->
          <div class="flex items-center gap-2">
            <IconLucideHash class="size-3.5 shrink-0 text-foreground-low" />
            <span class="font-mono text-foreground-low">{{ commit.hash }}</span>
          </div>

          <!-- Parents -->
          <div v-if="commit.parents.length > 0" class="flex items-start gap-2">
            <IconLucideGitCommitHorizontal class="size-3.5 shrink-0 text-foreground-low" />
            <div class="flex flex-col gap-0.5">
              <span
                v-for="parent in commit.parents"
                :key="parent"
                class="font-mono text-foreground-low"
              >
                {{ parent.slice(0, 7) }}
              </span>
            </div>
          </div>

          <!-- Refs -->
          <div v-if="commit.refs.length > 0" class="flex items-start gap-2">
            <IconLucideTag class="size-3.5 shrink-0 text-foreground-low" />
            <div class="flex flex-wrap gap-1">
              <span
                v-for="r in commit.refs"
                :key="r"
                class="rounded-sm bg-panel px-1 py-0.5 text-[10px] text-foreground"
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
