/**
 * Blame popover の module singleton。
 *
 * BlamePopover.vue は state を購読して描画するだけで、`open()` / `close()` /
 * `setViewMode()` は全てここに集約する。`defineExpose` で親から子の内部メソッドを
 * 呼ぶ設計を禁じる規約 (apps/renderer/CLAUDE.md) の対象を満たすため、composable
 * 経由のみで popover を操作する契約。
 *
 * race 設計:
 *   - `activeVersion` を open / close のたびに ++ し、await 復帰時に
 *     `version !== activeVersion` なら結果を破棄する
 *   - history 起点は blame で得た `commit.hash` + `commit.sourceLine` に固定する。
 *     表示中 rev で行が動いていても「blame した commit を起点に walk する」
 *     意味契約を守るため、`ctx.rev` を log -L の rev に流さない
 *   - history は blame 完了を必ず待ってから走る (loading 中 fallback 禁止)
 */
import type { GitBlameCommit, GitCommit } from "@gozd/proto";
import { tryCatch } from "@gozd/shared";
import { ref } from "vue";
import { useNotificationStore } from "../../shared/notification";
import { rpcGitBlameLine, rpcGitLogLine } from "./rpc";

type BlameContext = {
  dir: string;
  relPath: string;
  /** "" = working tree, "HEAD" / <hash> / "<hash>^" など */
  rev: string;
  /** 1-based、表示中のテキスト上の行番号 */
  line: number;
  /** ヘッダ補助表示 (Working Tree / HEAD / hash) */
  modeLabel: string;
};

type BlameState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; commit: GitBlameCommit }
  | { kind: "error"; message: string };

type HistoryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; commits: GitCommit[] }
  | { kind: "error"; message: string };

type ViewMode = "blame" | "history";

const HISTORY_MAX = 100;

const context = ref<BlameContext>();
const anchorEl = ref<HTMLElement>();
const openVersion = ref(0);
const viewMode = ref<ViewMode>("blame");
const blameState = ref<BlameState>({ kind: "idle" });
const historyState = ref<HistoryState>({ kind: "idle" });

let activeVersion = 0;
let blamePromise: Promise<void> | undefined;

async function loadBlame(ctx: BlameContext, version: number): Promise<void> {
  const notification = useNotificationStore();
  const result = await tryCatch(
    rpcGitBlameLine({ dir: ctx.dir, relPath: ctx.relPath, rev: ctx.rev, line: ctx.line }),
  );
  if (version !== activeVersion) return;
  if (!result.ok) {
    blameState.value = { kind: "error", message: result.error.message };
    notification.error("Failed to blame line", result.error);
    return;
  }
  const commit = result.value.commit;
  if (commit === undefined) {
    blameState.value = { kind: "error", message: "blame response had no commit" };
    return;
  }
  blameState.value = { kind: "ready", commit };
}

async function loadHistory(): Promise<void> {
  const ctx = context.value;
  if (ctx === undefined) return;
  // blame 完了を必ず待つ (race の章を参照)
  if (blamePromise) await blamePromise;
  const versionAtStart = activeVersion;
  const blame = blameState.value;
  if (blame.kind !== "ready") {
    // blame error / cancel 時は history も error に倒し、空配列 fallback で
    // 「touched no commit」と取り違えられないようにする
    historyState.value = {
      kind: "error",
      message: "Cannot load history: blame for this line did not resolve.",
    };
    return;
  }
  if (blame.commit.notCommitted) {
    // working tree 未コミット行は history walk しても結果が無い (空配列を返す)
    historyState.value = { kind: "ready", commits: [] };
    return;
  }
  historyState.value = { kind: "loading" };
  const notification = useNotificationStore();
  const result = await tryCatch(
    rpcGitLogLine({
      dir: ctx.dir,
      relPath: ctx.relPath,
      // history walk は blame した commit を起点に固定する。`ctx.rev` を流すと
      // 表示中 rev で行が後から動いた場合や Original (`<older>^`) を起点にした
      // 場合に、blame した commit が history に含まれない意味的ずれが起きる。
      rev: blame.commit.hash,
      line: blame.commit.sourceLine,
      maxCount: HISTORY_MAX,
    }),
  );
  if (versionAtStart !== activeVersion) return;
  if (!result.ok) {
    historyState.value = { kind: "error", message: result.error.message };
    notification.error("Failed to load line history", result.error);
    return;
  }
  historyState.value = { kind: "ready", commits: result.value.commits };
}

function open(el: HTMLElement, ctx: BlameContext): void {
  const version = ++activeVersion;
  context.value = ctx;
  anchorEl.value = el;
  viewMode.value = "blame";
  blameState.value = { kind: "loading" };
  historyState.value = { kind: "idle" };
  openVersion.value = version;
  blamePromise = loadBlame(ctx, version);
}

function close(): void {
  // 進行中の loadBlame / loadHistory を破棄させる
  activeVersion++;
  context.value = undefined;
  anchorEl.value = undefined;
  viewMode.value = "blame";
  blameState.value = { kind: "idle" };
  historyState.value = { kind: "idle" };
  blamePromise = undefined;
}

function setViewMode(mode: ViewMode): void {
  viewMode.value = mode;
  if (mode === "history" && historyState.value.kind === "idle") {
    void loadHistory();
  }
}

export function useBlamePopover() {
  return {
    context,
    anchorEl,
    openVersion,
    viewMode,
    blameState,
    historyState,
    open,
    close,
    setViewMode,
  };
}
