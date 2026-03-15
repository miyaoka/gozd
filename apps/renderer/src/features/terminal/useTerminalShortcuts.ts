/**
 * ターミナル分割のキーボードショートカット。
 * グローバル keydown リスナーで処理する（customKeyEventHandler は PTY 入力変換専用）。
 */
import { useEventListener } from "@vueuse/core";
import type { Ref, ShallowRef } from "vue";
import { findNavigationTarget } from "./useSpatialNavigation";
import { useTerminalStore } from "./useTerminalStore";

const ARROW_TO_DIRECTION: Record<string, "left" | "right" | "up" | "down"> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * ターミナル分割ショートカットを登録する。
 * MainLayout レベルで一度だけ呼ぶ。
 *
 * - Cmd+D: 横分割
 * - Cmd+Shift+D: 縦分割
 * - Cmd+W: フォーカス中のペインを閉じる（最後の1つは閉じない）
 * - Cmd+Opt+Arrow: 空間ナビゲーション
 */
export function useTerminalShortcuts(
  currentDir: Ref<string | undefined>,
  terminalContainerRef: Readonly<ShallowRef<HTMLElement | null>>,
) {
  const terminalStore = useTerminalStore();

  /** document.activeElement がターミナル配下にあるか判定する */
  function isTerminalFocused(): boolean {
    const container = terminalContainerRef.value;
    if (container === null) return false;

    const active = document.activeElement;
    if (active === null) return false;

    return container.contains(active);
  }

  useEventListener(document, "keydown", (e: KeyboardEvent) => {
    if (!e.metaKey) return;
    if (!isTerminalFocused()) return;

    const dir = currentDir.value;
    if (dir === undefined) return;

    const layout = terminalStore.layoutsByDir[dir];
    if (layout === undefined) return;

    // Cmd+D: 横分割 / Cmd+Shift+D: 縦分割
    if (e.key === "d" || e.key === "D") {
      e.preventDefault();
      const direction = e.shiftKey ? "vertical" : "horizontal";
      terminalStore.splitPane(dir, direction);
      return;
    }

    // Cmd+W: フォーカス中のペインを閉じる（最後の1つは閉じない）
    if (e.key === "w") {
      e.preventDefault();
      terminalStore.closePane(dir, layout.focusedLeafId);
      return;
    }

    // Cmd+Opt+Arrow: 空間ナビゲーション
    if (e.altKey) {
      const navDirection = ARROW_TO_DIRECTION[e.key];
      if (navDirection === undefined) return;

      const container = terminalContainerRef.value;
      if (container === null) return;

      const target = findNavigationTarget(layout.focusedLeafId, navDirection, container);
      if (target === undefined) return;

      e.preventDefault();
      terminalStore.focusPane(target);
    }
  });
}
