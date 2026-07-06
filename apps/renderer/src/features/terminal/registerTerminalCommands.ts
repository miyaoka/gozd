/**
 * ターミナル分割コマンドの登録。
 * クロージャで store と DOM 参照をキャプチャし、handler 内では毎回最新の Ref.value を読む。
 */
import type { Ref, ShallowRef } from "vue";
import { useCommandRegistry } from "../../shared/command";
import { useClosePaneConfirm } from "./useClosePaneConfirm";
import { findNavigationTarget } from "./useSpatialNavigation";
import { useTerminalStore } from "./useTerminalStore";

type Direction = "left" | "right" | "up" | "down";

/**
 * ターミナル分割・ナビゲーションのコマンドを登録する。
 * @returns dispose 関数（全コマンドを一括解除）
 */
export function registerTerminalCommands(
  currentDir: Ref<string | undefined>,
  terminalContainerRef: Readonly<ShallowRef<HTMLElement | null>>,
): () => void {
  const registry = useCommandRegistry();
  const terminalStore = useTerminalStore();
  const closeConfirm = useClosePaneConfirm();

  /** 現在の dir と layout を取得するヘルパー。無効なら undefined */
  function getActiveLayout() {
    const dir = currentDir.value;
    if (dir === undefined) return undefined;
    const layout = terminalStore.layoutsByDir[dir];
    if (layout === undefined) return undefined;
    return { dir, layout };
  }

  /**
   * フォーカス中の leaf が属する dir と layout を取得する。
   * マルチ表示で別 worktree の leaf にフォーカスしている場合に対応。
   * フォーカス leaf が見つからなければ currentDir にフォールバック。
   */
  function getFocusedLayout() {
    // フォーカス中の xterm を DOM から特定
    const container = terminalContainerRef.value;
    if (container === null) return getActiveLayout();
    const focused = container.querySelector("[data-leaf-id]:focus-within");
    if (focused === null) return getActiveLayout();
    const leafId = (focused as HTMLElement).dataset.leafId;
    if (leafId === undefined) return getActiveLayout();
    const dir = terminalStore.getPaneDir(leafId);
    if (dir === undefined) return getActiveLayout();
    const layout = terminalStore.layoutsByDir[dir];
    if (layout === undefined) return getActiveLayout();
    return { dir, layout };
  }

  /** 空間ナビゲーションのコマンド handler を生成する */
  function createFocusHandler(direction: Direction) {
    return (): boolean => {
      const active = getFocusedLayout();
      if (active === undefined) return false;

      const container = terminalContainerRef.value;
      if (container === null) return false;

      const target = findNavigationTarget(active.layout.focusedLeafId, direction, container);
      if (target === undefined) return false;

      terminalStore.focusPane(target);
      return true;
    };
  }

  const disposers = [
    registry.register("terminal.splitHorizontal", {
      label: "Terminal: Split Horizontal",
      handler: () => {
        const active = getFocusedLayout();
        if (active === undefined) return false;
        // split で増える新 pane は素の PTY（Claude 未起動）なので claude タイル対象外。
        // 既存 Claude leaf が残っていると claude ビュー実効値が解除されないため、
        // ここでユーザー意図を wt へ明示的に切り替える。同 PR 設計上の既存パターン
        // （useWorktreeActions / register*Command など）と同じ方針。
        terminalStore.viewMode = "wt";
        terminalStore.splitPane(active.dir, "horizontal");
        return true;
      },
    }),

    registry.register("terminal.splitVertical", {
      label: "Terminal: Split Vertical",
      handler: () => {
        const active = getFocusedLayout();
        if (active === undefined) return false;
        terminalStore.viewMode = "wt";
        terminalStore.splitPane(active.dir, "vertical");
        return true;
      },
    }),

    registry.register("terminal.closePane", {
      label: "Terminal: Close Pane",
      handler: () => {
        const active = getFocusedLayout();
        if (active === undefined) return false;
        const leafId = active.layout.focusedLeafId;
        const close = () => {
          // 最後の1ペインでは closePane が false を返すので、レイアウトをリセットして新ターミナルを起動
          if (!terminalStore.closePane(active.dir, leafId)) {
            terminalStore.resetLayout(active.dir);
          }
        };
        // Claude が作業中の pane は PTY kill で作業が失われるため確認を挟む
        // （done + pendingWork の「裏で作業継続中」も displayClaudeState が working に畳む）
        if (terminalStore.getClaudeState(leafId) === "working") {
          closeConfirm.request(close);
          return true;
        }
        close();
        return true;
      },
    }),

    registry.register("terminal.focusLeft", {
      label: "Terminal: Focus Left",
      handler: createFocusHandler("left"),
    }),
    registry.register("terminal.focusRight", {
      label: "Terminal: Focus Right",
      handler: createFocusHandler("right"),
    }),
    registry.register("terminal.focusUp", {
      label: "Terminal: Focus Up",
      handler: createFocusHandler("up"),
    }),
    registry.register("terminal.focusDown", {
      label: "Terminal: Focus Down",
      handler: createFocusHandler("down"),
    }),

    registry.register("workspace.toggleViewMode", {
      label: "Workspace: Toggle Active Worktree / Claude Terminals",
      handler: () => {
        terminalStore.toggleViewMode();
        return true;
      },
    }),
  ];

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
