<doc lang="md">
ファイルツリーのルートコンテナ。

## 動作

- ワークスペースのディレクトリが設定されるとルートエントリを読み込み、FileTreeItem を再帰的にレンダリング
- fsChange / gitStatusChange の RPC メッセージを購読し、変更があったディレクトリのみ差分更新
- git 削除ファイルは仮想エントリとしてツリーに挿入
- `reveal(targetPath)` で指定パスまでツリーを展開しスクロール
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { storeToRefs } from "pinia";
import { nextTick, onUnmounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { resolveGitChangeKind, useGitStatusStore, useWorktreeStore } from "../worktree";
import type { GitStatusChangePayload } from "../worktree";
import { getDeletedEntries, sortEntries } from "./filerUtils";
import type { FileEntry } from "./filerUtils";
import FileTreeItem from "./FileTreeItem.vue";
import { rpcFsReadDir } from "./rpc";
import type { FsChangePayload } from "./rpc";

const worktreeStore = useWorktreeStore();
const { dir, selectedPath } = storeToRefs(worktreeStore);
const gitStatusStore = useGitStatusStore();
const { gitStatuses } = storeToRefs(gitStatusStore);
const notify = useNotificationStore();

const rootEntries = ref<FileEntry[]>();
const loading = ref(false);
/** rootEntries 未読み込み時に保留する reveal 対象パス */
let pendingRevealPath: string | undefined;
/**
 * loadRoot の呼び出し世代カウンタ。await 境界で旧呼び出しが新呼び出しの結果を上書きしないよう、
 * 各呼び出しが自身の世代を保持して mismatch なら早期 return する。
 * dir 比較だけだと A → B → A のとき同じ dir 値で旧呼び出しと新呼び出しを区別できないため使う。
 */
let loadRootSeq = 0;

/** proto の FsReadDirEntry を FileEntry に変換する */
function toFileEntries(entries: { name: string; type: string; isIgnored: boolean }[]): FileEntry[] {
  return entries.map((e) => ({
    name: e.name,
    isDirectory: e.type === "directory",
    isIgnored: e.isIgnored,
  }));
}

/** readDir の結果に git 変更情報と削除ファイルをマージする */
function mergeWithGitStatus(entries: FileEntry[], dirPath: string): FileEntry[] {
  const existingNames = new Set(entries.map((e) => e.name));

  // 既存エントリに git 変更種別を付与
  const withGitChange = entries.map((entry) => {
    const filePath = dirPath === "" ? entry.name : `${dirPath}/${entry.name}`;
    const statusCode = gitStatuses.value[filePath];
    if (statusCode) {
      return { ...entry, gitChange: resolveGitChangeKind(statusCode) } as FileEntry;
    }
    return entry;
  });

  // 削除ファイルを追加（既存エントリと重複しないもののみ）
  const deletedEntries = getDeletedEntries(dirPath, gitStatuses.value).filter(
    (e) => !existingNames.has(e.name),
  );

  return sortEntries([...withGitChange, ...deletedEntries]);
}

async function loadRoot() {
  const mySeq = ++loadRootSeq;
  loading.value = true;
  const dirPath = dir.value;
  if (dirPath === undefined) {
    if (mySeq === loadRootSeq) {
      loading.value = false;
      rootEntries.value = [];
    }
    return;
  }
  // rpcFsReadDir と loadGitStatus を並列で投げ、readDir 失敗時のみエラー通知する。
  // loadGitStatus 側のエラーは store 内で個別に通知済み（cause を握り潰さない）。
  const [readResult] = await Promise.all([
    tryCatch(rpcFsReadDir({ dir: dirPath, path: "." })),
    gitStatusStore.loadGitStatus(),
  ]);
  // await 中に loadRoot が再度呼ばれた場合、この呼び出しの結果は破棄する。
  // 旧呼び出しが新 dir 用の rootEntries や pendingRevealPath を上書きするのを防ぐ。
  if (mySeq !== loadRootSeq) return;
  if (!readResult.ok) {
    notify.error("Failed to read root directory", readResult.error);
    rootEntries.value = [];
    // 世代チェック (line 上の `if (mySeq !== loadRootSeq) return;`) を通過した時点で
    // `mySeq === loadRootSeq` は確定だが、将来この早期 return の位置が変わった場合に
    //備えて重複ガードを置く。N+1 の `loading = true` を誤って消さない防御。
    if (mySeq === loadRootSeq) loading.value = false;
    return;
  }
  rootEntries.value = mergeWithGitStatus(toFileEntries(readResult.value.entries), "");
  if (mySeq === loadRootSeq) loading.value = false;

  // rootEntries 読み込み完了後に保留中の reveal を実行。
  // v-for の FileTreeItem がマウントされるのを nextTick で待つ。
  await nextTick();
  if (mySeq !== loadRootSeq) return;
  if (pendingRevealPath) {
    const path = pendingRevealPath;
    pendingRevealPath = undefined;
    void reveal(path);
  }
}

function onSelect(path: string) {
  worktreeStore.selectPath(path);
}

/**
 * 指定パスまでファイルツリーを展開し、対象ノードをスクロールインビューする。
 * ルートエントリの中から先頭セグメントに一致するアイテムを探して FileTreeItem.reveal に委譲する。
 */
async function reveal(targetPath: string): Promise<void> {
  if (!rootEntries.value) {
    // ルート読み込み中なら完了後に再試行する
    pendingRevealPath = targetPath;
    return;
  }

  const firstSegment = targetPath.split("/")[0];
  const index = rootEntries.value.findIndex((e) => e.name === firstSegment);
  if (index < 0) return;

  const item = treeItemRefs.value[index];
  if (item) {
    await item.reveal(targetPath);
  }
}

/**
 * ファイル変更通知を受けてツリーを更新するコールバック。
 * FileTreeItem の reloadDir を呼ぶため、ref 経由で子コンポーネントにアクセスする。
 */
const treeItemRefs = ref<InstanceType<typeof FileTreeItem>[]>([]);

function handleFsChange(relDir: string) {
  // ルートディレクトリの変更（"" or "."）
  if (relDir === "" || relDir === ".") {
    void loadRoot();
    return;
  }
  // 子ディレクトリの変更 → 該当する FileTreeItem に通知
  for (const item of treeItemRefs.value) {
    item.notifyChange(relDir);
  }
}

async function handleGitStatusChange() {
  // gitStatuses 自体は useGitStatusSync が repoStore に書き込み済み。
  // ここではファイルツリーの再構築（新規 / 削除ファイル反映）だけを行う。
  const dirPath = dir.value;
  if (dirPath === undefined) return;
  const result = await tryCatch(rpcFsReadDir({ dir: dirPath, path: "." }));
  if (!result.ok) {
    notify.error("Failed to rebuild root entries", result.error);
  } else {
    rootEntries.value = mergeWithGitStatus(toFileEntries(result.value.entries), "");
  }
  for (const item of treeItemRefs.value) {
    item.notifyGitStatusChange();
  }
}

// **watch 登録順依存**: `dir` watch を `revealVersion` watch より前に登録する必要がある。
// Vue は watch を登録順に発火させるため、setOpen({ selection }) で dir 変化と
// revealVersion ++ が同 tick で起きたとき、先に dir watch が `pendingRevealPath = undefined`
// で旧パスをクリアし、その後 revealVersion watch が新パスを積み直す順序になる。
// 入れ替えると revealVersion watch が先に走り、`pendingRevealPath` に積んだ直後の
// dir watch がそれを消してしまう（reveal が空振り）。登場順を変更する際は注意。
watch(
  dir,
  (newDir) => {
    if (newDir) {
      rootEntries.value = undefined;
      // 旧 dir 向けの保留 reveal が次の loadRoot 末尾で誤適用されないようクリアする
      pendingRevealPath = undefined;
      void loadRoot();
    }
  },
  { immediate: true },
);

// revealVersion の変化（selectPath 経由 / gozdOpen 経由など）で選択中パスを reveal する。
// 親から ref を expose せず worktreeStore 直接購読にすることで defineExpose を不要にする。
// immediate: true で初回 mount 時に既存 selectedPath があれば pendingRevealPath に積み、
// loadRoot 末尾で消化させる。これにより gozdOpen で渡された initial selection も
// この 1 経路に集約できる（旧 consumeInitialSelection 経路は廃止）。
// **invariant 依存**: revealVersion の bump は selection.value の更新と同期している
// （useWorktreeStore の selectPath() でのみ実行される）。両者が同 tick で揃わない経路を
// 増やすと古いパスで reveal が走る。
watch(
  () => worktreeStore.revealVersion,
  () => {
    const path = worktreeStore.selectedPath;
    if (path) void reveal(path);
  },
  { immediate: true },
);

const unsubscribeFsChange = onMessage<FsChangePayload>("fsChange", ({ relDir }) =>
  handleFsChange(relDir),
);
const unsubscribeGitStatus = onMessage<GitStatusChangePayload>("gitStatusChange", () =>
  handleGitStatusChange(),
);
onUnmounted(() => {
  unsubscribeFsChange();
  unsubscribeGitStatus();
});
</script>

<template>
  <div class="flex size-full flex-col">
    <!-- ツリー本体 -->
    <div class="flex-1 overflow-y-auto p-1">
      <div v-if="!dir" class="px-2 py-4 text-center text-sm text-zinc-500">
        waiting for open command...
      </div>
      <div v-else-if="loading && !rootEntries" class="px-2 py-4 text-center text-sm text-zinc-500">
        Loading...
      </div>
      <template v-else>
        <FileTreeItem
          v-for="entry in rootEntries"
          ref="treeItemRefs"
          :key="`${entry.name}-${entry.isDirectory}`"
          :name="entry.name"
          :path="entry.name"
          :is-directory="entry.isDirectory"
          :is-ignored="entry.isIgnored"
          :git-change="entry.gitChange"
          :git-statuses="gitStatuses"
          :depth="0"
          :selected-path="selectedPath"
          @select="onSelect"
        />
      </template>
    </div>
  </div>
</template>
