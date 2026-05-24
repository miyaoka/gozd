import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";

/**
 * Preview popover の開閉状態を保持する SSOT。
 *
 * `isOpen` は popover DOM の状態ではなく自前 ref で持つ。HTML Popover API の
 * `toggle` event は spec 上 task に queue される非同期発火のため、`hidePopover()`
 * / `showPopover()` 直後の同 tick で `popoverEl.matches(":popover-open")` を
 * 読んでも前の状態が見える窓がある。`open()` / `close()` の冪等 gate も自前 ref
 * のみで判定し、DOM state は判定材料にしない（DOM gate と ref gate が両方ある
 * と外因 race で「DOM=open / ref=closed」のような乖離状態に陥り、後続の close
 * 呼び出しが no-op に倒れて ref が永久にズレる）。
 *
 * `syncFromToggleEvent` は popover の `@toggle` event ハンドラから呼ぶ後追い同期。
 * `popover="manual"` では外因で open になる経路は存在せず close 方向の dismiss
 * （ESC handler が経路を持つが、自前 `close()` を通すよう揃えている）も自前経路を
 * 通す契約なので、event 経由は基本 no-op。ただし将来 popover 種別変更や外部経路
 * 追加で外因 close が起きた場合の保険として closed 方向のみ反映する。
 */
export const usePreviewStore = defineStore("preview", () => {
  const popoverEl = ref<HTMLElement>();
  const isOpen = ref(false);

  function bindPopover(el: HTMLElement | undefined) {
    popoverEl.value = el;
  }

  function open() {
    if (isOpen.value) return;
    const el = popoverEl.value;
    if (!el) return;
    el.showPopover();
    isOpen.value = true;
  }

  function close() {
    if (!isOpen.value) return;
    const el = popoverEl.value;
    if (!el) return;
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
    if (e.newState === "closed") {
      isOpen.value = false;
    }
  }

  return { isOpen, bindPopover, open, close, toggle, syncFromToggleEvent };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePreviewStore, import.meta.hot));
}
