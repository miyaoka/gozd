import { useEventListener } from "@vueuse/core";
import { ref } from "vue";
import { useContextKeys } from "../../shared/command";

/**
 * Ctrl キー押下状態の検知。
 * worktree の番号バッジ表示制御に使用する。
 * editable 要素（input / textarea / contentEditable）にフォーカスがある場合は抑制する。
 */
export function useCtrlBadge() {
  const ctrlPressed = ref(false);
  const contextKeys = useContextKeys();

  /**
   * keybinding が editable 要素を除外する条件と一致させる。
   * terminalFocus 時は xterm 内部の textarea を除外しない
   * （keybinding 側も同じ条件でスキップするため）
   */
  function shouldSuppressBadge(): boolean {
    if (contextKeys.get("terminalFocus")) return false;
    const target = document.activeElement;
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName;
    return tagName === "INPUT" || tagName === "TEXTAREA" || target.isContentEditable;
  }

  useEventListener(document, "keydown", (e: KeyboardEvent) => {
    if (e.key === "Control" && !shouldSuppressBadge()) ctrlPressed.value = true;
  });
  useEventListener(document, "keyup", (e: KeyboardEvent) => {
    if (e.key === "Control") ctrlPressed.value = false;
  });
  // ウィンドウからフォーカスが外れた場合にリセット
  useEventListener(window, "blur", () => {
    ctrlPressed.value = false;
  });
  // Ctrl 押下中に editable 要素にフォーカスが移った場合にリセット
  useEventListener(document, "focusin", () => {
    if (ctrlPressed.value && shouldSuppressBadge()) ctrlPressed.value = false;
  });

  return { ctrlPressed };
}
