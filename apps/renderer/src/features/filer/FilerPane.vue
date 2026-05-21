<doc lang="md">
ファイルツリーのルートコンテナ。

## 動作

- ワークスペースのディレクトリが設定されるとルートエントリを読み込み、FileTreeItem を再帰的にレンダリング
- fsChange / gitStatusChange の RPC メッセージを購読し、ルート再構築 + filer event store 経由で子に通知
- git 削除ファイルは仮想エントリとしてツリーに挿入
- 各 FileTreeItem は filer event store + worktreeStore.revealVersion を自律的に watch する設計
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { storeToRefs } from "pinia";
import { onUnmounted, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { onMessage } from "../../shared/rpc";
import { resolveGitChangeKind, useGitStatusStore, useWorktreeStore } from "../worktree";
import type { GitStatusChangePayload } from "../worktree";
import { getDeletedEntries, sortEntries, toFileEntries } from "./filerUtils";
import type { FileEntry } from "./filerUtils";
import FileTreeItem from "./FileTreeItem.vue";
import { rpcFsReadDir } from "./rpc";
import type { FsChangePayload } from "./rpc";
import { useFilerEventStore } from "./useFilerEventStore";

const worktreeStore = useWorktreeStore();
const { dir, selectedRelPath } = storeToRefs(worktreeStore);
const gitStatusStore = useGitStatusStore();
const { gitStatuses } = storeToRefs(gitStatusStore);
const notify = useNotificationStore();
const filerEventStore = useFilerEventStore();

const rootEntries = ref<FileEntry[]>();
const loading = ref(false);
/**
 * loadRoot の呼び出し世代カウンタ。await 境界で旧呼び出しが新呼び出しの結果を上書きしないよう、
 * 各呼び出しが自身の世代を保持して mismatch なら早期 return する。
 * dir 比較だけだと A → B → A のとき同じ dir 値で旧呼び出しと新呼び出しを区別できないため使う。
 */
let loadRootSeq = 0;
/**
 * handleGitStatusChange 専用の世代カウンタ。同一 dir 内で gitStatusChange push が
 * 連続発火した場合、`rpcFsReadDir` レスポンス順序が逆転して古い entries が新しい
 * entries を踏み潰す race を防ぐ。`loadRootSeq` と独立に持つことで、loadRoot の
 * 世代軸と互いに干渉しない SSOT として機能する。
 */
let gitStatusChangeSeq = 0;

/** readDir の結果に git 変更情報と削除ファイルをマージする */
function mergeWithGitStatus(entries: FileEntry[], dirPath: string): FileEntry[] {
  const existingNames = new Set(entries.map((e) => e.name));

  // 既存エントリに git 変更種別を付与
  const withGitChange = entries.map((entry): FileEntry => {
    const filePath = dirPath === "" ? entry.name : `${dirPath}/${entry.name}`;
    const statusCode = gitStatuses.value[filePath];
    if (statusCode) {
      return { ...entry, gitChange: resolveGitChangeKind(statusCode) };
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
  // 旧呼び出しが新 dir 用の rootEntries を上書きするのを防ぐ。
  if (mySeq !== loadRootSeq) return;
  if (!readResult.ok) {
    notify.error("Failed to read root directory", readResult.error);
    rootEntries.value = [];
    // 世代チェック (上の `if (mySeq !== loadRootSeq) return;`) を通過した時点で
    // `mySeq === loadRootSeq` は確定だが、将来この早期 return の位置が変わった場合に
    // 備えて重複ガードを置く。N+1 の `loading = true` を誤って消さない防御。
    if (mySeq === loadRootSeq) loading.value = false;
    return;
  }
  rootEntries.value = mergeWithGitStatus(toFileEntries(readResult.value.entries), "");
  if (mySeq === loadRootSeq) loading.value = false;
}

function onSelect(path: string) {
  worktreeStore.selectRelPath(path);
}

function handleFsChange(eventDir: string, relDir: string) {
  // useFsWatchSync は全 worktree を watch するため、別 repo / 別 worktree の
  // fsChange も到達する。active worktree dir 以外は無視する。
  if (eventDir !== dir.value) return;
  // worktree 直下の変更は loadRoot で全件再構築。relDir 表現は Swift
  // `FSWatchRegistry.relativeDir()` の SSOT に従い、直下は常に `""`。
  if (relDir === "") {
    void loadRoot();
    return;
  }
  // 子ディレクトリの変更は filer event store 経由で各 FileTreeItem に通知
  filerEventStore.emitFsChange(relDir);
}

async function handleGitStatusChange(eventDir: string) {
  // useFsWatchSync は全 worktree を watch するため、別 worktree の gitStatusChange も
  // 到達する。active worktree dir 以外は無視して空打ちの rpcFsReadDir を防ぐ。
  if (eventDir !== dir.value) return;
  // 子 FileTreeItem は store を watch して自分の path 配下のキャッシュを破棄/再読み込みする
  filerEventStore.emitGitStatusChange();
  // ルート rootEntries の再構築は FilerPane の責務として残す（gitStatuses 反映 + 削除エントリ）
  const dirPath = dir.value;
  if (dirPath === undefined) return;
  // dir 切替 race と同一 dir 内連続発火 race の両方を世代でガード。
  // 専用カウンタ gitStatusChangeSeq + loadRootSeq + dir.value の 3 軸チェックで
  // 「自分が投げた呼び出しの後により新しいものが来ていない」ことを構造的に保証する。
  const myGitStatusSeq = ++gitStatusChangeSeq;
  const myLoadSeq = loadRootSeq;
  const result = await tryCatch(rpcFsReadDir({ dir: dirPath, path: "." }));
  if (myGitStatusSeq !== gitStatusChangeSeq || myLoadSeq !== loadRootSeq || dir.value !== dirPath) {
    return;
  }
  if (!result.ok) {
    notify.error("Failed to rebuild root entries", result.error);
    return;
  }
  rootEntries.value = mergeWithGitStatus(toFileEntries(result.value.entries), "");
}

// dir watch は `flush: 'sync'` を指定して、setOpen({ selection }) で dir 変化と
// revealVersion ++ が同 tick で起きたとき必ず先に発火させる。
// （各 FileTreeItem の revealVersion watch はデフォルトの async flush なので、sync watch の後に走る）
// これにより「dir watch が rootEntries を初期化して loadRoot を起動 → 子マウント後の
// revealVersion watch (immediate) が target を処理」の順序が flush ステージで構造的に保証される。
watch(
  dir,
  (newDir) => {
    if (newDir) {
      rootEntries.value = undefined;
      void loadRoot();
    }
  },
  { immediate: true, flush: "sync" },
);

const unsubscribeFsChange = onMessage<FsChangePayload>("fsChange", ({ dir: eventDir, relDir }) =>
  handleFsChange(eventDir, relDir),
);
const unsubscribeGitStatus = onMessage<GitStatusChangePayload>(
  "gitStatusChange",
  ({ dir: eventDir }) => handleGitStatusChange(eventDir),
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
          :key="`${entry.name}-${entry.isDirectory}`"
          :name="entry.name"
          :path="entry.name"
          :is-directory="entry.isDirectory"
          :is-ignored="entry.isIgnored"
          :git-change="entry.gitChange"
          :git-statuses="gitStatuses"
          :depth="0"
          :selected-path="selectedRelPath"
          @select="onSelect"
        />
      </template>
    </div>
  </div>
</template>
