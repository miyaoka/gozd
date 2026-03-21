import { ref } from "vue";

/**
 * 確認ダイアログと通知ダイアログの状態管理。
 * テンプレート側の dialog 要素に ref をバインドして使う。
 */
export function useDialogs() {
  // --- 確認ダイアログ ---

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

  // --- 通知ダイアログ ---

  const alertRef = ref<HTMLDialogElement>();
  const alertMessage = ref("");

  function showAlert(message: string) {
    alertMessage.value = message;
    alertRef.value?.showModal();
  }

  return {
    confirmRef,
    confirmMessage,
    showConfirm,
    closeConfirm,
    executeConfirm,
    alertRef,
    alertMessage,
    showAlert,
  };
}
