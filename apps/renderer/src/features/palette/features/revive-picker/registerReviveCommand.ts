/**
 * セッション復活コマンド。削除済み worktree に紐づく Claude セッションを、worktree + task ごと
 * 作り直して resume する。
 *
 * ターゲット repo の解決は VSCode の SCM コマンド (`CommandCenter.createCommand` の
 * `getRepository(args[0]) ?? pickRepository()`) と同型:
 * - `args.rootDir` が渡れば (サイドバー repo メニューの明示クリック) それを使う
 * - 省略時 (コマンドパレット起動) は active worktree の owning repo に fall back する
 *   (gozd の active worktree は常に一意なので VSCode の repo picker は挟まない)
 *
 * precondition は付けない。`useCommandRegistry.execute` は precondition を active コンテキストで
 * 評価して実行自体を弾くため、precondition を付けると「active が非 git のとき、別の git repo を
 * サイドバーからクリックしても弾かれる」不整合が起きる。対象の妥当性は rootDir 解決で担保する。
 */

import type { ReviveSessionInfo } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { useCommandRegistry } from "../../../../shared/command";
import { useNotificationStore } from "../../../../shared/notification";
import { useRepoStore } from "../../../../shared/repo";
import { useTerminalStore } from "../../../terminal";
import { useWorktreeStore } from "../../../worktree";
import { rpcReviveSession, rpcReviveSessionList } from "./rpc";
import { useRevivePicker } from "./useRevivePicker";

export function registerReviveCommand(): () => void {
  const registry = useCommandRegistry();
  const { open, setResult, hide } = useRevivePicker();
  const notify = useNotificationStore();
  const repoStore = useRepoStore();
  const terminalStore = useTerminalStore();
  const worktreeStore = useWorktreeStore();

  /** args.rootDir (明示クリック) 優先、無ければ active worktree の owning repo。解決不能なら undefined。 */
  function resolveRootDir(args: unknown): string | undefined {
    if (typeof args === "object" && args !== null && "rootDir" in args) {
      const r = (args as { rootDir?: unknown }).rootDir;
      if (typeof r === "string" && r !== "") return r;
    }
    const activeDir = worktreeStore.dir;
    if (activeDir === undefined) return undefined;
    return repoStore.findRepoOwning(activeDir)?.rootDir;
  }

  /** 選択されたセッションを worktree + task ごと作り直し、visit で resume を駆動する。 */
  async function reviveSession(rootDir: string, session: ReviveSessionInfo) {
    const result = await tryCatch(
      rpcReviveSession({
        dir: rootDir,
        worktreeDir: session.worktreeDir,
        branch: session.branch,
        sessionId: session.sessionId,
      }),
    );
    if (!result.ok) {
      notify.error("Failed to revive session", result.error);
      return;
    }
    // worktree を即時反映 → 真値は requestRefresh で取り直す (楽観直書きしない規約)。
    repoStore.appendWorktree(rootDir, result.value.worktree);
    repoStore.requestRefresh(rootDir);
    terminalStore.setPreferredSetup(result.value.dir, result.value.setupScript);
    // setOpen の visit が resumableSessions 経由で `claude --resume <sessionId>` を仕込む。
    // task に sessionId を載せ済みなので requestNewClaudeSession (素の claude) は呼ばない。
    terminalStore.viewMode = "wt";
    worktreeStore.setOpen(result.value.dir);
  }

  /** loading で picker を開き、fetch 完了後に一覧を埋める。gen で stale 応答を捨てる。 */
  async function openReviveFor(rootDir: string) {
    const gen = open();
    const result = await tryCatch(rpcReviveSessionList({ dir: rootDir }));
    if (!result.ok) {
      if (hide(gen)) notify.error("Failed to load revivable sessions", result.error);
      return;
    }
    // viewer は revive では使わないので空文字。accept 束ねは ready 遷移後の選択で走る。
    setResult(gen, result.value.sessions, "", (session) => {
      void reviveSession(rootDir, session);
    });
  }

  return registry.register("workspace.reviveSession", {
    label: "Workspace: Revive Session",
    handler: (args?: unknown) => {
      const rootDir = resolveRootDir(args);
      if (rootDir === undefined) {
        // コマンドパレット起動で active repo も無い（repo 未オープン）ケース。silent に閉じず
        // fail-loud で知らせる（本 PR で execute の未登録 id を fail-loud にしたのと同じ思想）。
        notify.error("No repository available to revive sessions");
        return false;
      }
      void openReviveFor(rootDir);
      return true;
    },
  });
}
