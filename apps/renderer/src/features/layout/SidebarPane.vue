<doc lang="md">
左端のサイドバー。プロジェクトの worktree 一覧とブランチ一覧を表示する。

## 操作

- worktree クリック: 表示対象ディレクトリを切り替え
- worktree の unlink: 解除（まず通常削除を試行、未コミット変更がある場合は確認後 --force）
- ブランチの link: そのブランチで worktree を作成
- New worktree: 新規一時ブランチで worktree を作成
</doc>

<script setup lang="ts">
import type { WorktreeChangeCounts, WorktreeEntry } from "@orkis/rpc";
import { tryCatch } from "@orkis/shared";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useDiagnosticsStore } from "../diagnostics/useDiagnosticsStore";
import { useWorkspaceStore } from "../filer/useWorkspaceStore";
import { useRpc } from "../rpc/useRpc";
import { useTerminalStore } from "../terminal/useTerminalStore";

const workspaceStore = useWorkspaceStore();
const diagnosticsStore = useDiagnosticsStore();
const terminalStore = useTerminalStore();
const { request, onGitStatusChange, onWorktreeChange } = useRpc();

const worktrees = ref<WorktreeEntry[]>([]);
/** worktree 化されていないローカルブランチ */
const freeBranches = ref<string[]>([]);
const isCreating = ref(false);
const isSwitching = ref(false);
/** fetchData の世代管理（並行実行で stale なレスポンスを破棄するため） */
let fetchGen = 0;

/** main 先頭、残りはブランチ名のアルファベット順 */
const sortedWorktrees = computed(() =>
  [...worktrees.value].sort((a, b) => {
    if (a.isMain) return -1;
    if (b.isMain) return 1;
    return (a.branch ?? "").localeCompare(b.branch ?? "");
  }),
);

const sortedBranches = computed(() => [...freeBranches.value].sort((a, b) => a.localeCompare(b)));

/** 現在表示中の worktree かどうか */
function isActive(wt: WorktreeEntry): boolean {
  return workspaceStore.dir === wt.path;
}

/** 変更ファイルがあるかどうか */
function hasChanges(counts: WorktreeChangeCounts | undefined): boolean {
  if (!counts) return false;
  return counts.modified + counts.added + counts.deleted + counts.untracked > 0;
}

/** 確認ダイアログ */
const confirmRef = ref<HTMLDialogElement>();
const confirmMessage = ref("");
const confirmAction = ref<(() => Promise<void>) | undefined>();

function showConfirm(message: string, action: () => Promise<void>) {
  confirmMessage.value = message;
  confirmAction.value = action;
  confirmRef.value?.showModal();
}

function closeConfirm() {
  confirmRef.value?.close();
  confirmAction.value = undefined;
}

async function executeConfirm() {
  const action = confirmAction.value;
  if (!action) return;
  closeConfirm();
  await action();
}

/** 通知ダイアログ */
const alertRef = ref<HTMLDialogElement>();
const alertMessage = ref("");

function showAlert(message: string) {
  alertMessage.value = message;
  alertRef.value?.showModal();
}

async function fetchData() {
  if (!workspaceStore.dir) return;
  const gen = ++fetchGen;
  const [wtList, branchList] = await Promise.all([
    request.gitWorktreeList(),
    request.gitBranchList(),
  ]);
  // 並行実行された新しい fetchData が先に完了していたら、この結果は stale なので破棄
  if (gen !== fetchGen) return;
  worktrees.value = wtList;
  const wtBranches = new Set(wtList.map((wt) => wt.branch).filter(Boolean));
  freeBranches.value = branchList.filter((b) => !wtBranches.has(b));
}

/** worktree をクリックして表示対象を切り替える */
async function handleWorktreeSelect(wt: WorktreeEntry) {
  if (isActive(wt) || isSwitching.value) return;
  isSwitching.value = true;
  const result = await tryCatch(request.switchDir({ dir: wt.path }));
  if (result.ok) {
    diagnosticsStore.clear();
    workspaceStore.setOpen(result.value.dir, undefined, result.value.fileServerBaseUrl);
  }
  isSwitching.value = false;
}

async function addWorktree(branch?: string) {
  isCreating.value = true;
  if (branch) {
    freeBranches.value = freeBranches.value.filter((b) => b !== branch);
  }

  const result = await tryCatch(request.gitWorktreeAdd({ branch }));
  if (result.ok) {
    await fetchData();
  } else if (branch) {
    freeBranches.value.push(branch);
  }
  isCreating.value = false;
}

function removeFromList(wt: WorktreeEntry) {
  worktrees.value = worktrees.value.filter((w) => w.path !== wt.path);
  // ブランチが残る場合は freeBranches に戻す
  if (wt.branch) {
    freeBranches.value.push(wt.branch);
  }
  // ターミナルの visitedDirs から除去（TerminalPane を破棄させる）
  terminalStore.remove(wt.path);
}

/** worktree 解除: まず通常削除、失敗したら確認後 --force */
async function handleWorktreeRemove(wt: WorktreeEntry) {
  const result = await tryCatch(request.gitWorktreeRemove({ path: wt.path }));
  if (result.ok) {
    removeFromList(wt);
    return;
  }
  showConfirm(
    `"${wt.branch}" の解除に失敗しました（未コミットの変更がある可能性があります）。強制的に解除しますか？`,
    async () => {
      const forceResult = await tryCatch(request.gitWorktreeRemove({ path: wt.path, force: true }));
      if (forceResult.ok) {
        removeFromList(wt);
      } else {
        showAlert(`"${wt.branch}" の強制解除に失敗しました。`);
      }
    },
  );
}

watch(() => workspaceStore.dir, fetchData, { immediate: true });

const cleanups: Array<() => void> = [];
onMounted(() => {
  cleanups.push(onGitStatusChange(() => fetchData()));
  cleanups.push(onWorktreeChange(() => fetchData()));
});
onUnmounted(() => {
  for (const cleanup of cleanups) cleanup();
});
</script>

<template>
  <div class="flex size-full flex-col p-4">
    <h1 class="mb-4 text-lg font-bold">
      <span class="mr-2 icon-[lucide--bot] align-middle text-blue-400" />
      orkis
    </h1>

    <div class="flex flex-col">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-xs font-medium text-zinc-500">WORKTREES</h2>
        <button
          type="button"
          class="grid size-6 place-items-center rounded-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          :class="terminalStore.showAll && 'bg-zinc-700 text-zinc-200'"
          title="全 worktree のターミナルを一覧表示"
          @click="terminalStore.showAll = !terminalStore.showAll"
        >
          <span class="icon-[lucide--layout-grid] text-sm" />
        </button>
      </div>

      <div
        v-for="wt in sortedWorktrees"
        :key="wt.path"
        class="group/wt grid cursor-pointer grid-cols-[auto_1fr_auto] gap-x-2 rounded-sm py-1.5 pl-2"
        :class="isActive(wt) ? 'bg-zinc-700/50' : 'hover:bg-zinc-800'"
        @click="handleWorktreeSelect(wt)"
      >
        <span
          class="row-span-2 mt-0.5 text-base"
          :class="
            wt.isMain
              ? 'icon-[lucide--home] text-zinc-500'
              : 'icon-[lucide--git-branch] text-zinc-400'
          "
        />
        <span
          class="truncate text-sm"
          :class="
            isActive(wt)
              ? 'font-medium text-blue-300'
              : wt.isMain
                ? 'text-zinc-400'
                : 'text-zinc-200'
          "
        >
          {{ wt.branch ?? "(detached)" }}
        </span>
        <span
          v-if="wt.isMain && !isActive(wt)"
          class="row-span-2 self-center pr-2 text-xs text-zinc-600"
          >ref</span
        >
        <button
          v-else-if="!wt.isMain && !isActive(wt)"
          class="row-span-2 grid size-10 place-items-center self-center text-zinc-600 opacity-0 transition-opacity group-hover/wt:opacity-100 hover:text-red-400"
          @click.stop="handleWorktreeRemove(wt)"
        >
          <span class="icon-[lucide--unlink] text-sm" />
        </button>
        <span v-else class="row-span-2" />
        <span class="flex items-center gap-2 text-xs">
          <span class="font-mono text-zinc-600">{{ wt.head }}</span>
          <span
            v-if="wt.changeCounts && hasChanges(wt.changeCounts)"
            class="flex items-center gap-1.5"
          >
            <span
              v-if="wt.changeCounts.modified > 0"
              class="text-yellow-500"
              :title="`${wt.changeCounts.modified} modified`"
            >
              <span class="mr-0.5 icon-[lucide--pencil] align-middle text-[10px]" />{{
                wt.changeCounts.modified
              }}
            </span>
            <span
              v-if="wt.changeCounts.added > 0"
              class="text-green-500"
              :title="`${wt.changeCounts.added} added`"
            >
              <span class="mr-0.5 icon-[lucide--plus] align-middle text-[10px]" />{{
                wt.changeCounts.added
              }}
            </span>
            <span
              v-if="wt.changeCounts.deleted > 0"
              class="text-red-500"
              :title="`${wt.changeCounts.deleted} deleted`"
            >
              <span class="mr-0.5 icon-[lucide--minus] align-middle text-[10px]" />{{
                wt.changeCounts.deleted
              }}
            </span>
            <span
              v-if="wt.changeCounts.untracked > 0"
              class="text-zinc-400"
              :title="`${wt.changeCounts.untracked} untracked`"
            >
              <span class="mr-0.5 icon-[lucide--help-circle] align-middle text-[10px]" />{{
                wt.changeCounts.untracked
              }}
            </span>
          </span>
        </span>
      </div>

      <p v-if="worktrees.length === 0" class="py-2 pl-2 text-sm text-zinc-500">読み込み中...</p>

      <button
        class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 rounded-sm py-1.5 pl-2 text-left text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        :disabled="isCreating"
        @click="addWorktree()"
      >
        <span class="icon-[lucide--plus] text-base" />
        <span>New worktree</span>
      </button>
    </div>

    <div v-if="sortedBranches.length > 0" class="mt-4 flex flex-col">
      <h2 class="mb-1 text-xs font-medium text-zinc-500">BRANCHES</h2>

      <div
        v-for="branch in sortedBranches"
        :key="branch"
        class="group/br grid grid-cols-[auto_1fr_auto] gap-x-2 rounded-sm py-1.5 pl-2 text-sm text-zinc-500 hover:bg-zinc-800"
      >
        <span class="icon-[lucide--git-branch] text-base" />
        <span class="truncate">{{ branch }}</span>
        <button
          class="grid size-8 place-items-center self-center text-zinc-600 opacity-0 transition-opacity group-hover/br:opacity-100 hover:text-zinc-300"
          :disabled="isCreating"
          @click="addWorktree(branch)"
        >
          <span class="icon-[lucide--link] text-sm" />
        </button>
      </div>
    </div>

    <dialog
      ref="confirmRef"
      class="fixed inset-0 m-auto size-fit rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-white backdrop:bg-black/50"
      @click="$event.target === confirmRef && closeConfirm()"
    >
      <p class="mb-4 text-sm">{{ confirmMessage }}</p>
      <div class="flex justify-end gap-2">
        <button
          class="rounded-sm px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          @click="closeConfirm"
        >
          キャンセル
        </button>
        <button
          class="rounded-sm bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-500"
          @click="executeConfirm"
        >
          削除
        </button>
      </div>
    </dialog>

    <dialog
      ref="alertRef"
      class="fixed inset-0 m-auto size-fit rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-white backdrop:bg-black/50"
      @click="$event.target === alertRef && alertRef?.close()"
    >
      <p class="mb-4 text-sm">{{ alertMessage }}</p>
      <div class="flex justify-end">
        <button
          class="rounded-sm px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          @click="alertRef?.close()"
        >
          閉じる
        </button>
      </div>
    </dialog>
  </div>
</template>
