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

/**
 * 与えられた path が blame 対象として有効か判定する。
 * 絶対パス始まりの file (filer の "open external" 経路) は git 管理外として false。
 * PreviewPane / ChangesSummaryItem の重複判定を 1 箇所に集約する SSOT。
 *
 * `undefined` / 空文字も false に倒す。selectedPath が未確定なケースの安全策。
 */
export function isBlameablePath(path: string | undefined): boolean {
  if (path === undefined || path === "") return false;
  if (path.startsWith("/")) return false;
  return true;
}

const HISTORY_MAX = 100;

// notification は module scope で 1 度だけ取得。load 系関数の毎回呼び出しを避け、
// 既存 store 利用パターン (script setup の最上位で取得) と揃える。
// `useNotificationStore` は Pinia ではなく plain module ref singleton のため、
// import 時点で生存し最初の呼び出しから安定して使える。
const notification = useNotificationStore();

const context = ref<BlameContext>();
const anchorEl = ref<HTMLElement>();
const openVersion = ref(0);
const viewMode = ref<ViewMode>("blame");
const blameState = ref<BlameState>({ kind: "idle" });
const historyState = ref<HistoryState>({ kind: "idle" });

let activeVersion = 0;
/**
 * 進行中の blame 取得とその version を 1 つにバインドして保持する。
 * loadHistory は「自分の version の blame」を待ちたいので、let の素 Promise だと
 * await 評価時の参照を引きずって別 version の blame を待ち続けるバグになる。
 * tuple で version を一緒に持つことで、await 後の version 不一致を検出して
 * 「他 version の blame に乗ったまま history 発射」を構造的に防ぐ。
 */
let blameInFlight: { version: number; promise: Promise<void> } | undefined;

async function loadBlame(ctx: BlameContext, version: number): Promise<void> {
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
    // proto schema 違反 (server が必須フィールドを返さない予期しない経路)。
    // popover が閉じた後に観察不能にならないよう state error + toast を併発する。
    const err = new Error("blame response had no commit");
    blameState.value = { kind: "error", message: err.message };
    notification.error("Failed to blame line", err);
    return;
  }
  blameState.value = { kind: "ready", commit };
}

async function loadHistory(): Promise<void> {
  // version は await 前に capture。await 後の activeVersion 比較で「途中で open() が
  // 走って別 context に切り替わった」場合に history 結果を捨てる。
  const myVersion = activeVersion;
  const ctx = context.value;
  if (ctx === undefined) return;
  // History タブを開いた瞬間に loading 表示へ倒す。blame await 後の分岐で loading を
  // 後置きすると、history タブクリック直後に template の 3 つの v-if (loading / error /
  // ready) いずれにも該当しない idle のまま 1 フレーム空描画が出る (UX 違和感)
  historyState.value = { kind: "loading" };
  // 自分 version の blame の完了を待つ。別 version の in-flight (古い参照) は無視する。
  const bp = blameInFlight;
  if (bp !== undefined && bp.version === myVersion) {
    await bp.promise;
    if (myVersion !== activeVersion) return;
  }
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
  if (myVersion !== activeVersion) return;
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
  blameInFlight = { version, promise: loadBlame(ctx, version) };
}

function close(): void {
  // 進行中の loadBlame / loadHistory を破棄させる
  activeVersion++;
  context.value = undefined;
  anchorEl.value = undefined;
  viewMode.value = "blame";
  blameState.value = { kind: "idle" };
  historyState.value = { kind: "idle" };
  blameInFlight = undefined;
}

/**
 * 自身が open 元 (matchPath = アクティブ context の relPath と一致) であれば close を発火。
 * owner (ChangesSummaryItem / PreviewPane) の unmount 時に呼んで detached anchor を残さない。
 * 他 owner が open している context にぶつけても no-op で安全。
 */
function closeIfActive(relPath: string): void {
  if (context.value?.relPath === relPath) {
    close();
  }
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
    closeIfActive,
    setViewMode,
  };
}
