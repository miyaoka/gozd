/**
 * dialog 要素の制御を composable に閉じ込める。
 * コンポーネントと show/close 関数を返し、利用側は slot で中身を差し込む。
 */

import { defineComponent, h, ref, watch, type SlotsType } from "vue";

export function useDialog() {
  const isOpen = ref(false);

  function show() {
    isOpen.value = true;
  }

  function close() {
    isOpen.value = false;
  }

  const Dialog = defineComponent({
    slots: Object as SlotsType<{ default: Record<string, never> }>,
    inheritAttrs: false,
    emits: ["close"],
    setup(_, { slots, attrs, emit }) {
      const dialogEl = ref<HTMLDialogElement>();

      watch(isOpen, (open) => {
        if (open) {
          dialogEl.value?.showModal();
        } else {
          dialogEl.value?.close();
        }
      });

      return () =>
        h(
          "dialog",
          {
            ...attrs,
            ref: dialogEl,
            onClose: () => {
              // ブラウザの Escape キーで dialog が閉じた場合にも isOpen を同期する
              isOpen.value = false;
              emit("close");
            },
            onClick: (e: MouseEvent) => {
              // backdrop クリック（dialog 要素自体への直接クリック）で閉じる
              if (e.target === dialogEl.value) {
                isOpen.value = false;
              }
            },
          },
          slots.default?.({}),
        );
    },
  });

  return { Dialog, isOpen, show, close };
}
