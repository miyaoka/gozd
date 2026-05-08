<doc lang="md">
アプリケーションのルートコンポーネント。

## 責務

- Swift → renderer の `gozdOpen` push を受信し、ワークスペース（ディレクトリ・ファイル）を設定する
- `notify` push を受信してトースト表示する
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { onMounted, onUnmounted, watch } from "vue";
import { rpcFsUnwatch, rpcFsWatch } from "./features/filer";
import { MainLayout } from "./features/layout";
import { rpcGitBranchList, rpcGitWorktreeList } from "./features/sidebar";
import { useTerminalStore } from "./features/terminal";
import { useGitStatusStore, useWorktreeStore } from "./features/worktree";
import { useAppStore } from "./shared/app";
import { useCommandRegistry, useContextKeys, useKeyBindings } from "./shared/command";
import { useNotificationStore } from "./shared/notification";
import { useRepoStore } from "./shared/repo";
import { onMessage } from "./shared/rpc";

interface GozdOpenPayload {
  dir: string;
  selection?: { kind: string; relPath: string; lineNumber: number };
  channel: string;
  repoName: string;
  isGitRepo: boolean;
  switchToDir: string;
}

interface NotifyPayload {
  type: "error" | "info";
  source: string;
  message: string;
  detail: string;
}

useKeyBindings();

const worktreeStore = useWorktreeStore();
const appStore = useAppStore();
const repoStore = useRepoStore();
const terminalStore = useTerminalStore();
const gitStatusStore = useGitStatusStore();
const contextKeys = useContextKeys();
const notify = useNotificationStore();
const { setErrorHandler } = useCommandRegistry();
setErrorHandler(notify.error);

const disposeNotify = onMessage<NotifyPayload>("notify", ({ type, source, message, detail }) => {
  const notifyFn = type === "error" ? notify.error : notify.info;
  notifyFn(`[${source}] ${message}`, detail);
});

let cleanup: (() => void) | undefined;

/**
 * gozdOpen 受信時の repo 解決フロー:
 *  1. targetDir が既存のいずれかの repo の worktrees に含まれる → 切替のみ（既存 repo フォーカス）
 *  2. 含まれない → 新規 repo として worktrees / branches を fetch して repoStore に登録 → 切替
 */
async function handleGozdOpen(payload: GozdOpenPayload) {
  const { dir, selection, channel, repoName, isGitRepo, switchToDir } = payload;
  if (channel) {
    appStore.setChannel(channel);
  }
  const targetDir = switchToDir !== "" ? switchToDir : dir;
  // proto3 scalar では undefined が表現できないため、空 selection は未指定として扱う
  const sel = selection !== undefined && selection.relPath !== "" ? selection : undefined;

  if (repoStore.findRepoOwning(targetDir) === undefined) {
    // 新規 repo: worktrees / freeBranches を取得してから登録
    let worktrees: import("@gozd/proto").WorktreeEntry[] = [];
    let freeBranches: string[] = [];
    if (isGitRepo) {
      const result = await tryCatch(
        Promise.all([rpcGitWorktreeList({ dir }), rpcGitBranchList({ dir })]),
      );
      if (result.ok) {
        const [wtRes, branchRes] = result.value;
        worktrees = wtRes.worktrees;
        const wtBranches = new Set(worktrees.map((wt) => wt.branch).filter(Boolean));
        freeBranches = branchRes.branches.filter((b) => !wtBranches.has(b));
      } else {
        notify.error("Failed to fetch repo data", result.error);
      }
    }
    repoStore.addRepo({ rootDir: dir, repoName, isGitRepo, worktrees, freeBranches });
  }

  worktreeStore.setOpen(targetDir, { selection: sel });
}

onMounted(() => {
  cleanup = onMessage<GozdOpenPayload>("gozdOpen", (payload) => {
    void handleGozdOpen(payload);
  });
});

// 選択中 repo の isGitRepo を context key に反映（when 条件で git 関連コマンドを制御）
const stopWatchIsGitRepo = watch(
  () => repoStore.selectedIsGitRepo,
  (isGitRepo) => contextKeys.set("isGitRepo", isGitRepo),
  { immediate: true },
);

// worktreeStore.dir の変更に追従して FSWatchRegistry の対象 dir を切り替える。
// 旧 dir は unwatch、新 dir は watch することで、サーバー側の FSWatcher を
// 現在表示中の worktree に同期させる（fsChange / gitStatusChange 等の push が届く）。
const stopWatchDir = watch(
  () => worktreeStore.dir,
  async (newDir, oldDir) => {
    if (oldDir !== undefined && oldDir !== newDir) {
      await tryCatch(rpcFsUnwatch({ dir: oldDir }));
    }
    if (newDir !== undefined && newDir !== oldDir) {
      const result = await tryCatch(rpcFsWatch({ dir: newDir }));
      if (!result.ok) {
        notify.error("Failed to start FS watch", result.error);
      }
    }
  },
  { immediate: true },
);

// 選択中 repo に紐づく PTY の Claude state 集合を文字列化して watch する。
// state 遷移（idle/working/asking/done）が起きたら、選択中 dir の git status を再取得する。
// fsChange と並ぶ「git status 更新トリガー」のもう一方。Claude が動く dir では FS watch を
// 入れていなくても、エージェント完了時に状態を最新化できるための経路。
const stopWatchClaudeForGitStatus = watch(
  () => {
    const dir = repoStore.selectedDir;
    if (dir === undefined) return "";
    const statuses = terminalStore.getClaudeStatusesByDir(dir);
    return statuses
      .map((s) => s.state)
      .sort()
      .join(",");
  },
  (newKey, oldKey) => {
    if (newKey === oldKey) return;
    void gitStatusStore.loadGitStatus();
  },
);

onUnmounted(() => {
  cleanup?.();
  disposeNotify();
  stopWatchDir();
  stopWatchIsGitRepo();
  stopWatchClaudeForGitStatus();
  if (worktreeStore.dir !== undefined) {
    void tryCatch(rpcFsUnwatch({ dir: worktreeStore.dir }));
  }
});
</script>

<template>
  <MainLayout />
</template>
