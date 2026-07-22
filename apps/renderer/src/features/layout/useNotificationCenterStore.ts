import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useNotificationStore } from "../../shared/notification";

/**
 * Notification center パネルの開閉 + 未読管理の SSOT。EventLogPanel / ServerListPanel と
 * 同じ右ドック popover 流儀で、開閉状態を store が所有し popover DOM へのミラーは
 * `open()` / `close()` が担う。通知データ自体は `shared/notification` が SSOT で、
 * 本 store は開閉と既読位置 (`lastSeenSeq`) だけを扱う。
 *
 * 未読は「seq が lastSeenSeq より新しい項目」。seq は重複抑制の再発生でも進むため、
 * 既存項目への再発生も未読に戻る。パネルが開いている間は watch が既読位置を最新 seq に
 * 追従させるので、開いた瞬間 + 開いている間の新着は即座に既読化される。
 */
export const useNotificationCenterStore = defineStore("notificationCenter", () => {
  const { notifications } = useNotificationStore();

  const popoverEl = ref<HTMLElement>();
  const isOpen = ref(false);
  const lastSeenSeq = ref(0);

  const latestSeq = computed(() => notifications.value.reduce((max, n) => Math.max(max, n.seq), 0));
  const unseen = computed(() => notifications.value.filter((n) => n.seq > lastSeenSeq.value));
  const unseenCount = computed(() => unseen.value.length);
  const hasUnseenError = computed(() => unseen.value.some((n) => n.type === "error"));

  watch([isOpen, latestSeq], ([open, seq]) => {
    if (open) lastSeenSeq.value = seq;
  });

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

  return { isOpen, unseenCount, hasUnseenError, bindPopover, open, close, toggle };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useNotificationCenterStore, import.meta.hot));
}
