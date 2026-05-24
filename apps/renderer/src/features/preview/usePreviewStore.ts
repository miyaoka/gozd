import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

/**
 * Preview popover の開閉状態を保持する SSOT。
 *
 * `isOpen` は popover DOM の状態ではなく自前 ref で持つ。HTML Popover API の
 * `toggle` event は spec 上 task に queue される非同期発火のため、`hidePopover()`
 * / `showPopover()` 直後の同 tick で `popoverEl.matches(":popover-open")` を
 * 読んでも前の状態が見える窓がある。`open()` / `close()` 内で同 tick に `isOpen`
 * を直接書き換えることで、navigator pane 等の同期消費側に race を露呈させない。
 *
 * `syncFromToggleEvent` は popover の `@toggle` event ハンドラから呼ぶ backup。
 * 自前 `open` / `close` を経由しない外因 (ESC dismiss など) で state が動いたとき
 * の整合を取る。自前経路は既に同期で書き換えているため event 経由は no-op になる。
 */
export const usePreviewStore = defineStore("preview", () => {
  const popoverEl = ref<HTMLElement>();
  const isOpen = ref(false);

  function bindPopover(el: HTMLElement | undefined) {
    popoverEl.value = el;
  }

  function open() {
    const el = popoverEl.value;
    if (!el || el.matches(":popover-open")) return;
    el.showPopover();
    isOpen.value = true;
  }

  function close() {
    const el = popoverEl.value;
    if (!el || !el.matches(":popover-open")) return;
    el.hidePopover();
    isOpen.value = false;
  }

  function toggle() {
    if (isOpen.value) {
      close();
    } else {
      open();
    }
  }

  function syncFromToggleEvent(e: ToggleEvent) {
    isOpen.value = e.newState === "open";
  }

  return { isOpen, bindPopover, open, close, toggle, syncFromToggleEvent };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePreviewStore, import.meta.hot));
}
