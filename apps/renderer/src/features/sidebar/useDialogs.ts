import { ref } from "vue";
import { useNotificationStore } from "../../shared/notification";

/**
 * 確認ダイアログの状態管理。
 * テンプレート側の dialog 要素に ref をバインドして使う。
 */
export function useDialogs() {
  const notify = useNotificationStore();
  const confirmRef = ref<HTMLDialogElement>();
  const confirmMessage = ref("");
  const confirmAction = ref<(() => Promise<void>) | undefined>();

  function showConfirm(message: string, action: () => Promise<void>) {
    const dialog = confirmRef.value;
    if (dialog === undefined) {
      notify.error("Confirmation dialog not mounted", new Error("confirmRef is undefined"));
      return;
    }
    confirmMessage.value = message;
    confirmAction.value = action;
    dialog.showModal();
  }

  function closeConfirm() {
    const dialog = confirmRef.value;
    if (dialog === undefined) {
      notify.error("Confirmation dialog not mounted", new Error("confirmRef is undefined"));
      return;
    }
    dialog.close();
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
