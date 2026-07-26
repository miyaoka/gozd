import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

/**
 * イベントログパネルの開閉 SSOT。ServerListPanel と同じ右ドック popover 流儀で、開閉状態は
 * store が所有し DOM は触らない。popover へのミラーは EventLogPanel が `isOpen` を watch して
 * `shared/surface` へ流す (usePreviewStore / useServerStore と同流儀)。ログデータ自体は
 * `shared/debug` の ring buffer が SSOT で、本 store は開閉だけを扱う。
 */
export const useEventLogStore = defineStore("eventLog", () => {
  const isOpen = ref(false);

  function open(): void {
    isOpen.value = true;
  }
  function close(): void {
    isOpen.value = false;
  }
  function toggle(): void {
    if (isOpen.value) {
      close();
    } else {
      open();
    }
  }

  return { isOpen, open, close, toggle };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useEventLogStore, import.meta.hot));
}
