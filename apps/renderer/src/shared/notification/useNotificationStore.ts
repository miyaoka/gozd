/**
 * 通知ストア。module singleton パターン。
 * トースト通知の追加・削除・タイムアウト管理を行う。
 */
import { ref } from "vue";

interface Notification {
  id: number;
  type: "error" | "info";
  message: string;
  cause?: unknown;
}

/** info 通知の自動消去時間（ms） */
const INFO_AUTO_DISMISS_MS = 5000;

let nextId = 0;
const notifications = ref<Notification[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const CONSOLE_BY_TYPE = {
  error: console.error,
  info: console.info,
} as const;

/**
 * 同一メッセージの重複を抑制する。既に表示中ならトーストは追加せず、cause だけ最新で上書きする。
 * cause を上書きするのは、ユーザーが Copy する詳細を最新の発生時点に揃えるため。
 */
function add(type: Notification["type"], message: string, cause?: unknown) {
  CONSOLE_BY_TYPE[type](message, ...(cause !== undefined ? [cause] : []));

  const duplicate = notifications.value.find((n) => n.type === type && n.message === message);
  if (duplicate) {
    duplicate.cause = cause;
    return;
  }

  const id = nextId++;
  notifications.value.push({ id, type, message, cause });

  if (type === "info") {
    const timer = setTimeout(() => dismiss(id), INFO_AUTO_DISMISS_MS);
    timers.set(id, timer);
  }
}

function dismiss(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  notifications.value = notifications.value.filter((n) => n.id !== id);
}

export function useNotificationStore() {
  return {
    notifications,
    error: (message: string, cause?: unknown) => add("error", message, cause),
    info: (message: string, cause?: unknown) => add("info", message, cause),
    dismiss,
  };
}
