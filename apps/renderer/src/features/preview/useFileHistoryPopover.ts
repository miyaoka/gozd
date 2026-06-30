/**
 * ファイル単位の history popover の module singleton。
 *
 * preview ヘッダのコミット日 (FileCommitDate) クリックで開き、表示中ファイルの
 * `git log -- <path>` 一覧を出す。行単位の `useBlamePopover` と並列の別経路で、
 * blame ステップを持たず history 一本の state だけを管理する。
 *
 * FileHistoryPopover.vue は state を購読して描画するだけで、`open()` / `close()` は
 * ここに集約する (`defineExpose` 禁止規約: apps/renderer/CLAUDE.md)。
 *
 * race 設計は useBlamePopover と同型: `activeVersion` を open / close のたびに ++ し、
 * await 復帰時に version 不一致なら結果を破棄する。
 */
import type { GitCommit } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { ref } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcGitLogFile } from "./rpc";

type FileHistoryContext = {
  dir: string;
  relPath: string;
  /** "" = HEAD (working tree の最新コミット) / "HEAD" / <hash> / "<hash>^" など */
  rev: string;
  /** ヘッダ補助表示 (Working Tree / HEAD / hash) */
  modeLabel: string;
};

type HistoryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; commits: GitCommit[] }
  | { kind: "error"; message: string };

const HISTORY_MAX = 100;

const notification = useNotificationStore();

const context = ref<FileHistoryContext>();
const anchorEl = ref<HTMLElement>();
const openVersion = ref(0);
const historyState = ref<HistoryState>({ kind: "idle" });

let activeVersion = 0;

async function loadHistory(ctx: FileHistoryContext, version: number): Promise<void> {
  const result = await tryCatch(
    rpcGitLogFile({
      dir: ctx.dir,
      relPath: ctx.relPath,
      rev: ctx.rev,
      maxCount: HISTORY_MAX,
    }),
  );
  if (version !== activeVersion) return;
  if (!result.ok) {
    historyState.value = { kind: "error", message: result.error.message };
    notification.error("Failed to load file history", result.error);
    return;
  }
  historyState.value = { kind: "ready", commits: result.value.commits };
}

function open(el: HTMLElement, ctx: FileHistoryContext): void {
  const version = ++activeVersion;
  context.value = ctx;
  anchorEl.value = el;
  historyState.value = { kind: "loading" };
  openVersion.value = version;
  void loadHistory(ctx, version);
}

function close(): void {
  // 進行中の loadHistory を破棄させる
  activeVersion++;
  context.value = undefined;
  anchorEl.value = undefined;
  historyState.value = { kind: "idle" };
}

/**
 * アクティブ context が同 dir + 同 relPath のときだけ close を発火。
 * 他 owner / 他 file に対して開いている context にぶつけても no-op で安全
 * (useBlamePopover.closeIfActive と同型)。
 */
function closeIfActive(dir: string, relPath: string): void {
  const ctx = context.value;
  if (ctx === undefined) return;
  if (ctx.dir === dir && ctx.relPath === relPath) {
    close();
    return;
  }
  notification.debug("[useFileHistoryPopover] closeIfActive no-op: context mismatch", {
    requested: { dir, relPath },
    active: { dir: ctx.dir, relPath: ctx.relPath },
  });
}

export function useFileHistoryPopover() {
  return {
    context,
    anchorEl,
    openVersion,
    historyState,
    open,
    close,
    closeIfActive,
  };
}
