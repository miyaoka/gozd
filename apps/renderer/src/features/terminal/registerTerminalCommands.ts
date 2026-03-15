/**
 * ターミナル分割コマンドの登録。
 * クロージャで store と DOM 参照をキャプチャし、handler 内では毎回最新の Ref.value を読む。
 */
import type { Ref, ShallowRef } from "vue";
import { useCommandRegistry } from "../command/useCommandRegistry";
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

  /** 空間ナビゲーションのコマンド handler を生成する */
  function createFocusHandler(direction: Direction) {
    return (): boolean => {
      const active = getActiveLayout();
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
      const active = getActiveLayout();
      if (active === undefined) return false;
      terminalStore.splitPane(active.dir, "horizontal");
      return true;
    }),

    registry.register("terminal.splitVertical", () => {
      const active = getActiveLayout();
      if (active === undefined) return false;
      terminalStore.splitPane(active.dir, "vertical");
      return true;
    }),

    registry.register("terminal.closePane", () => {
      const active = getActiveLayout();
      if (active === undefined) return false;
      return terminalStore.closePane(active.dir, active.layout.focusedLeafId);
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
