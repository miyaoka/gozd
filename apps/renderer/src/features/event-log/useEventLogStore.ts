import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

/**
 * イベントログパネルの開閉 SSOT。ServerListPanel と同じ右ドック popover 流儀で、開閉状態を
 * store が所有し popover DOM へのミラーは `open()` / `close()` が担う (usePreviewStore / useServerStore
 * と同流儀)。ログデータ自体は `shared/debug` の ring buffer が SSOT で、本 store は開閉だけを扱う。
 */
export const useEventLogStore = defineStore("eventLog", () => {
  const popoverEl = ref<HTMLElement>();
  const isOpen = ref(false);

  function bindPopover(el: HTMLElement | undefined): void {
    popoverEl.value = el;
  }
  function open(): void {
    if (isOpen.value) return;
    const el = popoverEl.value;
    if (!el) return;
    el.showPopover();
    isOpen.value = true;
  }
  function close(): void {
    if (!isOpen.value) return;
    const el = popoverEl.value;
    if (!el) return;
    el.hidePopover();
    isOpen.value = false;
  }
  function toggle(): void {
    if (isOpen.value) {
      close();
    } else {
      open();
    }
  }

  return { isOpen, bindPopover, open, close, toggle };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useEventLogStore, import.meta.hot));
}
