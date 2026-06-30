<doc lang="md">
preview ヘッダにファイルの最終コミット日を表示し、クリックでファイル history popover を開く。

`git log -1 -- <path>` (rpcGitLogFile maxCount=1) で表示中 rev 時点の最新コミットを取得し、
相対日付として描画する。クリックで `useFileHistoryPopover().open()` を呼ぶ。

## リアクティブ更新

- props (`dir` / `relPath` / `rev`) 変化で再 fetch (ファイル切替 / タブ・commit 選択切替に追従)
- HEAD 追従 rev (`""` / `"HEAD"`) のときは active dir の `gitStatusChange` (head 変化) でも
  再 fetch し、terminal でコミット後にヘッダ日付が古びないようにする
- race は version counter で破棄する
</doc>

<script setup lang="ts">
import type { GitCommit } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { onUnmounted, ref, useTemplateRef, watch } from "vue";
import { onMessage } from "../../shared/rpc";
import { formatAbsoluteTime, formatRelativeTime } from "../../shared/time";
import type { GitStatusChangePayload } from "../worktree";
import { revModeLabel } from "./revModeLabel";
import { rpcGitLogFile } from "./rpc";
import { useFileHistoryPopover } from "./useFileHistoryPopover";
import IconLucideHistory from "~icons/lucide/history";

const props = defineProps<{
  dir: string;
  relPath: string;
  /** 表示中 rev。"" = HEAD (working tree の最新コミット) / "HEAD" / <hash> / "<hash>^" */
  rev: string;
  /** git 管理下かつ rev 解決済みのとき true。false なら何も描画しない (絶対パス等を除外) */
  enabled: boolean;
}>();

const fileHistory = useFileHistoryPopover();

const buttonRef = useTemplateRef<HTMLButtonElement>("buttonRef");
const lastCommit = ref<GitCommit>();

let fetchVersion = 0;
// 直近 fetch を発火させた repo HEAD OID。gitStatusChange の churn 抑制に使う (下記購読参照)。
let lastFetchedHead: string | undefined;

async function fetchLastCommit(): Promise<void> {
  if (!props.enabled) {
    lastCommit.value = undefined;
    return;
  }
  const myVersion = ++fetchVersion;
  const result = await tryCatch(
    rpcGitLogFile({ dir: props.dir, relPath: props.relPath, rev: props.rev, maxCount: 1 }),
  );
  if (myVersion !== fetchVersion) return;
  if (!result.ok) {
    // 取得失敗 (権限 / git 異常等) は日付を出さないだけに倒す。preview 本体の content 取得が
    // 同条件で error トーストを出すため、ヘッダ補助表示でトーストを二重に出さない。
    lastCommit.value = undefined;
    return;
  }
  lastCommit.value = result.value.commits[0];
}

watch(
  () => [props.dir, props.relPath, props.rev, props.enabled],
  () => {
    // ファイル / rev 切替で head 追跡をリセットし、新コンテキストの baseline を取り直す。
    lastFetchedHead = undefined;
    void fetchLastCommit();
  },
  { immediate: true },
);

// HEAD 追従 rev のときだけ、active dir のコミット (head 変化) でヘッダ日付を更新する。
// `gitStatusChange` は StatusFull (mtime 込み Equatable) 由来で working-tree 編集ごとに飛ぶため、
// head が前回 fetch 時と同一なら skip する。ファイルの最新コミットが動くのは head 移動時
// (commit / amend / reset / checkout / rebase) だけで、編集では変わらないため churn を弾ける。
// 固定 hash rev は HEAD が動いても起点が不変なので、そもそも再 fetch しない。
const unsubscribe = onMessage<GitStatusChangePayload>("gitStatusChange", ({ dir, head }) => {
  if (dir !== props.dir) return;
  if (props.rev !== "" && props.rev !== "HEAD") return;
  if (head === lastFetchedHead) return;
  lastFetchedHead = head;
  void fetchLastCommit();
});
onUnmounted(unsubscribe);

function onClick(): void {
  const el = buttonRef.value;
  if (el === null) return;
  fileHistory.open(el, {
    dir: props.dir,
    relPath: props.relPath,
    rev: props.rev,
    modeLabel: revModeLabel(props.rev),
  });
}
</script>

<template>
  <button
    v-if="enabled && lastCommit !== undefined"
    ref="buttonRef"
    type="button"
    class="flex shrink-0 items-center gap-1 text-xs text-foreground-low hover:text-foreground"
    :title="`${lastCommit.shortHash} · ${formatAbsoluteTime(Number(lastCommit.date))}\n${lastCommit.message}`"
    aria-label="Show file history"
    @click="onClick"
  >
    <IconLucideHistory class="size-3.5" />
    {{ formatRelativeTime(Number(lastCommit.date)) }}
  </button>
</template>
