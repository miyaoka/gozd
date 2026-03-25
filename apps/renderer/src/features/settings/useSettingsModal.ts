/**
 * 設定モーダルの制御 composable（module singleton）。
 * モーダルの open/close 状態管理とコマンド登録を行う。
 */

import { ref } from "vue";
import { useCommandRegistry } from "../../shared/command";

const isOpen = ref(false);

function open() {
  isOpen.value = true;
}

function close() {
  isOpen.value = false;
}

/** コマンド登録。MainLayout で一度だけ呼び出す */
export function registerSettingsCommand(): () => void {
  const registry = useCommandRegistry();
  return registry.register("settings.open", {
    label: "Settings: Open",
    handler: () => {
      open();
      return true;
    },
  });
}

export function useSettingsModal() {
  return { isOpen, open, close };
}
