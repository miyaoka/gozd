<doc lang="md">
Changed files tree. Shows HEAD vs working directory by default, or a selected commit's changes from the git graph.

## Display

- Files are rendered as a directory tree, GitHub PR diff style
- A folder whose only child is another folder is concatenated with the child (e.g. `.github/workflows`).
  Concatenation stops as soon as a folder contains a file or more than one entry
- Folders default to expanded; clicking a folder row toggles collapse. State is kept in `Set<string>` keyed by full path
- Each file row shows a material-icon-theme icon, the file name colored by change type, and the change type
  badge (M/A/D/R/U) at the trailing edge

## Data source

- Default (Uncommitted Changes selected): shows git status converted to GitFileChange[]
- Normal commit selected: fetches changed files via `gitCommitFiles` RPC
- Shift+click range:
  - Walks first-parents from the upper endpoint (newer, falling back to HEAD when newer is
    Working Tree) until reaching the lower endpoint's display position. Both endpoints are
    inclusive when they sit on the walked line.
  - Independent commits from another branch that the date-sorted display interleaves are
    skipped because they are not on `parents[0]`.
  - The resulting hash list is sent to the backend as `range_hashes` and stored in the
    git-graph store as `activeCommitHashes` for dot highlighting.
  - When the range includes Working Tree, `include_working_tree=true` is sent so the backend
    diffs against the working tree (`git diff <older>^`).
  - When the non-Working-Tree endpoint is the HEAD commit AND HEAD is not at the top of the
    commits array (origin/main commits are interleaved above HEAD), the range collapses to
    "Working Tree only" — RPC is skipped and gitStatuses is shown as if a single Uncommitted
    Changes row were selected. Visual range highlighting is preserved. When HEAD is the top
    commit (no other branch above it), the range is treated normally so HEAD's commit diff
    plus uncommitted changes are both shown.
- Clicking a file emits `select` with the relative path
</doc>

<script setup lang="ts">
import type { GitCommit, GitFileChange } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { computed, ref, watch } from "vue";
import { rpcGitCommitFiles, useGitGraphStore } from "../git-graph";
import {
  UNCOMMITTED_HASH,
  useGitStatusStore,
  resolveGitChangeKind,
  useWorktreeStore,
} from "../worktree";
import type { GitChangeKind } from "../worktree";
import { buildChangesTree } from "./changesTree";
import ChangesTreeItem from "./ChangesTreeItem.vue";

const emit = defineEmits<{
  select: [relPath: string];
}>();

const worktreeStore = useWorktreeStore();
const gitGraphStore = useGitGraphStore();
const gitStatusStore = useGitStatusStore();

/** コミット選択時に取得した変更ファイル一覧 */
const commitFiles = ref<GitFileChange[]>([]);
const loading = ref(false);
/** in-flight リクエストの無効化用シーケンス番号 */
let requestSeq = 0;

/** Uncommitted Changes 行が選択されているか */
const isUncommittedMode = computed(() => gitGraphStore.selectedHash === UNCOMMITTED_HASH);

/** 範囲選択モードか */
const isRangeMode = computed(() => gitGraphStore.compareHash !== null);

/** HEAD ref を持つ commit の hash */
const headHash = computed(() => gitGraphStore.commits.find((c) => c.refs.includes("HEAD"))?.hash);

/** 範囲選択の片端が Working Tree か */
const includesWorkingTree = computed(
  () =>
    gitGraphStore.selectedHash === UNCOMMITTED_HASH ||
    gitGraphStore.compareHash === UNCOMMITTED_HASH,
);

/** 非 Working Tree 側 endpoint の hash */
const otherEndpointHash = computed(() =>
  gitGraphStore.selectedHash === UNCOMMITTED_HASH
    ? gitGraphStore.compareHash
    : gitGraphStore.selectedHash,
);

/**
 * Working Tree のみとして処理すべきか。
 *
 * 「Working Tree と HEAD を選んだが、HEAD が表示順で最上位ではない」ケースに限定する。
 * これは origin/main 等が HEAD より進行していて、Working Tree と HEAD の間に他枝の
 * commit が挟まっている状態。範囲を素直に解釈すると挟まる commit まで含めてしまうので、
 * uncommitted changes のみに倒す。
 *
 * HEAD が表示順で最上位 (commits[0]) の通常ケース (Working Tree → HEAD で間に他 commit
 * なし) では false を返し、`include_working_tree=true` の通常 range として処理する
 * (`git diff <HEAD>^` で HEAD コミット差分 + uncommitted changes が出る)。
 */
const workingTreeOnly = computed(() => {
  if (!isRangeMode.value || !includesWorkingTree.value) return false;
  const otherHash = otherEndpointHash.value;
  if (otherHash === null || otherHash !== headHash.value) return false;
  const headIdx = gitGraphStore.hashToIndex.get(otherHash);
  return headIdx !== undefined && headIdx > 0;
});

/** git status の Record<string, string> を GitFileChange[] に変換 */
function gitStatusToFileChanges(statuses: Record<string, string>): GitFileChange[] {
  return Object.entries(statuses).map(([filePath, statusCode]) => {
    const kind = resolveGitChangeKind(statusCode);
    const TYPE_MAP: Record<GitChangeKind, GitFileChange["type"]> = {
      modified: "M",
      added: "A",
      deleted: "D",
      untracked: "U",
      renamed: "R",
    };
    return {
      oldFilePath: filePath,
      newFilePath: filePath,
      type: TYPE_MAP[kind],
    };
  });
}

/**
 * 表示するファイル一覧。
 *
 * - 単一 Working Tree 選択: gitStatuses ベース (uncommitted changes)
 * - workingTreeOnly (Working Tree + HEAD の範囲): gitStatuses ベース (single Working Tree と一致)
 * - それ以外: commitFiles ref (RPC で取得した diff)
 */
const fileChanges = computed<GitFileChange[]>(() => {
  if ((isUncommittedMode.value && !isRangeMode.value) || workingTreeOnly.value) {
    return gitStatusToFileChanges(gitStatusStore.gitStatuses);
  }
  return commitFiles.value;
});

const fileCount = computed(() => fileChanges.value.length);

/**
 * GitHub PR 風のディレクトリツリー（chain 圧縮済み）。
 *
 * `buildChangesTree` は不正 path（空 segment / 重複 / file⇔folder 衝突）で throw する。
 * computed 内の throw はペイン全体を白画面化するため、Result でラップしてテンプレート側で
 * エラー表示分岐に倒す。
 */
const treeResult = computed(() => tryCatch(() => buildChangesTree(fileChanges.value)));

/** 折りたたみ中フォルダの fullPath 集合（デフォルトは全展開） */
const collapsedFolders = ref<Set<string>>(new Set());

function toggleFolder(fullPath: string) {
  const next = new Set(collapsedFolders.value);
  if (next.has(fullPath)) {
    next.delete(fullPath);
  } else {
    next.add(fullPath);
  }
  collapsedFolders.value = next;
}

/**
 * 範囲選択時の対象 commit hash 列を組み立てる。
 *
 * 仕様: newer (上端) から `commit.parents[0]` を辿り、older の表示位置に到達したら停止する。
 * 「先端ブランチの first-parent walk」を表現し、別枝の独立コミット（mergeCommitStreams が
 * date 順で挿入する origin/HEAD 系の commit など）は対象に含まれない。
 *
 * 終了条件:
 *   - 次の commit が older の表示位置を **超えた**（older 自身は first-parent 線上にあれば含む）
 *   - 次の commit が commits 配列に存在しない（= log フェッチ範囲外）
 *   - parents[0] が無い（= root commit）
 *
 * UNCOMMITTED_HASH 端の扱い:
 *   - newer = UNCOMMITTED_HASH: HEAD ref を持つ commit を walk 開始点にフォールバック
 *   - older = UNCOMMITTED_HASH: stopIdx = -1 → 即停止すべきところを Infinity に倒し、
 *     walk が最後まで進むようにする（Working Tree 端は「最も新しい」扱い）
 */
function buildRangeHashes(
  selected: string,
  compare: string,
  hashToIndex: Map<string, number>,
  commits: readonly GitCommit[],
): string[] {
  const sIdx = selected === UNCOMMITTED_HASH ? -1 : (hashToIndex.get(selected) ?? Infinity);
  const cIdx = compare === UNCOMMITTED_HASH ? -1 : (hashToIndex.get(compare) ?? Infinity);

  const newerIsSelected = sIdx <= cIdx;
  const newerRaw = newerIsSelected ? selected : compare;
  const olderIdxRaw = newerIsSelected ? cIdx : sIdx;

  const startHash =
    newerRaw === UNCOMMITTED_HASH
      ? (commits.find((c) => c.refs.includes("HEAD"))?.hash ?? "")
      : newerRaw;
  if (startHash === "") return [];

  // older が UNCOMMITTED_HASH (-1) の場合は stopIdx を Infinity にして最後まで walk する
  const stopIdx = olderIdxRaw < 0 ? Number.POSITIVE_INFINITY : olderIdxRaw;

  const result: string[] = [];
  let currentHash = startHash;
  while (true) {
    const idx = hashToIndex.get(currentHash);
    if (idx === undefined || idx > stopIdx) break;
    const commit = commits[idx];
    result.push(commit.hash);
    if (idx === stopIdx) break; // older 自身に到達。追加してから停止
    const firstParent = commit.parents[0];
    if (firstParent === undefined) break;
    currentHash = firstParent;
  }
  return result;
}

// コミット選択 / commits 配列が変わったら変更ファイルを取得
// commits 依存を持つことで、fetch / branch update / HEAD 変化で commits が再構築された後も
// rangeHashes / activeCommitHashes / Changes diff / workingTreeOnly が再評価される
watch(
  () => [gitGraphStore.selectedHash, gitGraphStore.compareHash, gitGraphStore.commits] as const,
  async ([hash, compareHash]) => {
    const seq = ++requestSeq;

    // 単一 Working Tree 選択: 既存通り gitStatuses 経由
    if (hash === UNCOMMITTED_HASH && compareHash === null) {
      commitFiles.value = [];
      loading.value = false;
      return;
    }
    const dir = worktreeStore.dir;
    if (dir === undefined) {
      commitFiles.value = [];
      loading.value = false;
      return;
    }

    // 範囲選択 mode
    if (compareHash !== null) {
      // workingTreeOnly: activeCommitHashes を空集合にして dot 強調と Detail pane も
      // 「Uncommitted Changes のみ」に倒す。visual range (isSelectedRow) は維持される
      if (workingTreeOnly.value) {
        gitGraphStore.setActiveCommitHashes([]);
        commitFiles.value = [];
        loading.value = false;
        return;
      }

      const rangeHashes = buildRangeHashes(
        hash,
        compareHash,
        gitGraphStore.hashToIndex,
        gitGraphStore.commits,
      );
      gitGraphStore.setActiveCommitHashes(rangeHashes);

      // Working Tree 端を含むのに HEAD が見つからない: walk 起点が決まらないので空に倒す
      if (includesWorkingTree.value && headHash.value === undefined) {
        commitFiles.value = [];
        loading.value = false;
        return;
      }

      // rangeHashes 空: range 解決失敗。単一 commit 経路に落とさず空で確定
      if (rangeHashes.length === 0) {
        commitFiles.value = [];
        loading.value = false;
        return;
      }

      loading.value = true;
      const result = await tryCatch(
        rpcGitCommitFiles({
          dir,
          hash,
          compareHash,
          rangeHashes,
          includeWorkingTree: includesWorkingTree.value,
        }),
      );
      if (seq !== requestSeq) return;
      commitFiles.value = result.ok ? result.value.changes : [];
      loading.value = false;
      return;
    }

    // 単一 commit mode
    loading.value = true;
    const result = await tryCatch(
      rpcGitCommitFiles({
        dir,
        hash,
        compareHash: "",
        rangeHashes: [],
        includeWorkingTree: false,
      }),
    );
    if (seq !== requestSeq) return;
    commitFiles.value = result.ok ? result.value.changes : [];
    loading.value = false;
  },
  { immediate: true },
);
</script>

<template>
  <div
    class="flex size-full flex-col overflow-hidden border-l border-zinc-700 bg-zinc-900 text-zinc-300"
  >
    <div class="flex shrink-0 items-center gap-1.5 border-b border-zinc-700 px-3 py-1.5">
      <span class="icon-[lucide--git-branch] size-4 text-zinc-400" />
      <span class="text-xs font-semibold text-zinc-400">Changes</span>
      <span v-if="fileCount > 0" class="text-xs text-zinc-500">({{ fileCount }})</span>
    </div>

    <div v-if="loading" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-zinc-500">Loading...</div>
    </div>

    <div v-else-if="!treeResult.ok" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-red-400">Failed to build tree: {{ String(treeResult.error) }}</div>
    </div>

    <div v-else-if="treeResult.value.length === 0" class="flex-1 overflow-y-auto p-2">
      <div class="text-xs text-zinc-500">No changes</div>
    </div>

    <div v-else class="flex-1 overflow-y-auto py-1">
      <ChangesTreeItem
        v-for="node in treeResult.value"
        :key="node.kind === 'folder' ? `d:${node.anchorPath}` : `f:${node.change.newFilePath}`"
        :node="node"
        :depth="0"
        :collapsed="collapsedFolders"
        @select="emit('select', $event)"
        @toggle-folder="toggleFolder"
      />
    </div>
  </div>
</template>
