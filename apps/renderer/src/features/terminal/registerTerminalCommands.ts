/**
 * ターミナル分割コマンドの登録。
 * クロージャで store と DOM 参照をキャプチャし、handler 内では毎回最新の Ref.value を読む。
 */
import type { Ref, ShallowRef } from "vue";
import { useCommandRegistry } from "../../shared/command";
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
    const entry = terminalStore.paneRegistry[leafId];
    if (entry === undefined) return getActiveLayout();
    const layout = terminalStore.layoutsByDir[entry.dir];
    if (layout === undefined) return getActiveLayout();
    return { dir: entry.dir, layout };
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
    registry.register("terminal.splitHorizontal", () => {
      const active = getFocusedLayout();
      if (active === undefined) return false;
      terminalStore.splitPane(active.dir, "horizontal");
      return true;
    }),

    registry.register("terminal.splitVertical", () => {
      const active = getFocusedLayout();
      if (active === undefined) return false;
      terminalStore.splitPane(active.dir, "vertical");
      return true;
    }),

    registry.register("terminal.closePane", () => {
      const active = getFocusedLayout();
      if (active === undefined) return false;
      // 最後の1ペインでは closePane が false を返すので、レイアウトをリセットして新ターミナルを起動
      if (!terminalStore.closePane(active.dir, active.layout.focusedLeafId)) {
        terminalStore.resetLayout(active.dir);
      }
      return true;
    }),

    registry.register("terminal.focusLeft", createFocusHandler("left")),
    registry.register("terminal.focusRight", createFocusHandler("right")),
    registry.register("terminal.focusUp", createFocusHandler("up")),
    registry.register("terminal.focusDown", createFocusHandler("down")),
  ];

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
