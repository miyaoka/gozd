import { ref } from "vue";

/**
 * 確認ダイアログの状態管理。
 * テンプレート側の dialog 要素に ref をバインドして使う。
 */
export function useDialogs() {
  const confirmRef = ref<HTMLDialogElement>();
  const confirmMessage = ref("");
  const confirmAction = ref<(() => Promise<void>) | undefined>();

  function showConfirm(message: string, action: () => Promise<void>) {
    confirmMessage.value = message;
    confirmAction.value = action;
    confirmRef.value?.showModal();
  }

  function closeConfirm() {
    confirmRef.value?.close();
    confirmAction.value = undefined;
  }

  async function executeConfirm() {
    const action = confirmAction.value;
    if (!action) return;
    closeConfirm();
    await action();
  }

  return {
    confirmRef,
    confirmMessage,
    showConfirm,
    closeConfirm,
    executeConfirm,
  };
}
