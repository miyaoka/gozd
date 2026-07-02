/**
 * ファイル単位の history popover の module singleton。
 *
 * preview ヘッダのコミット日 (FileCommitDate) クリックで開き、表示中ファイルの
 * `git log -- <path>` 一覧を出す。行単位の `useBlamePopover` と並列の別経路。
 *
 * popover の開閉・anchor 付け替え・light-dismiss・toggle race は共通抽象
 * `shared/popover/usePopover` に委譲し、本 composable は RPC race
 * (`activeVersion` + `historyState`) だけを所有する。FileHistoryPopover.vue は
 * `Popover` + `context` + `historyState` を購読して描画するだけ。
 */
import type { GitCommit } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { effectScope, ref, watch } from "vue";
import { useNotificationStore } from "../../../../shared/notification";
import { usePopover } from "../../../../shared/popover";
import { rpcGitLogFile } from "../../rpc";

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
const popover = usePopover<FileHistoryContext>();

const historyState = ref<HistoryState>({ kind: "idle" });

// open / close (light-dismiss 含む) のたびに ++ し、await 復帰時に version 不一致なら破棄する。
let activeVersion = 0;

// popover が閉じる (context が undefined になる) と進行中の loadHistory を破棄し state を戻す。
// usePopover の onToggle 経由 light-dismiss も context clear に集約されるため、close 経路を
// 1 つに束ねられる。
const scope = effectScope(true);
scope.run(() => {
  watch(popover.context, (ctx) => {
    if (ctx === undefined) {
      activeVersion++;
      historyState.value = { kind: "idle" };
    }
  });
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    popover.stop();
    scope.stop();
  });
}

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
  historyState.value = { kind: "loading" };
  popover.open(el, ctx);
  void loadHistory(ctx, version);
}

/**
 * アクティブ context が同 dir + 同 relPath のときだけ閉じる。他 owner / 他 file の context に
 * ぶつけても no-op で安全 (useBlamePopover.closeIfActive と同型)。
 */
function closeIfActive(dir: string, relPath: string): void {
  const ctx = popover.context.value;
  if (ctx === undefined) return;
  if (ctx.dir === dir && ctx.relPath === relPath) {
    popover.close();
    return;
  }
  notification.debug("[useFileHistoryPopover] closeIfActive no-op: context mismatch", {
    requested: { dir, relPath },
    active: { dir: ctx.dir, relPath: ctx.relPath },
  });
}

export function useFileHistoryPopover() {
  return {
    Popover: popover.Popover,
    context: popover.context,
    historyState,
    open,
    close: popover.close,
    closeIfActive,
  };
}
