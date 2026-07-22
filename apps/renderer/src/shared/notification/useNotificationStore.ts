/**
 * 通知ストア。module singleton パターン。
 * トースト通知の追加・削除を行う。全種別とも自動消去せず手動クローズのみ
 * (背景処理の失敗通知は目撃前に消えると silent drop と等価になるため)。
 *
 * `error` / `warning` / `info` は toast 表示 + console 出力、`debug` は **console.debug への
 * 集約窓口**で toast 表示なし。renderer 規約 (CLAUDE.md エラーハンドリング) で
 * 「呼び出し側で console を直書きしない (store 経由)」方針を満たすため、
 * 切り分け用 log もこの store 経由で発火する。
 */
import { ref } from "vue";

interface Notification {
  id: number;
  type: "error" | "warning" | "info";
  message: string;
  cause?: unknown;
}

let nextId = 0;
const notifications = ref<Notification[]>([]);

/**
 * 最後に発火した通知イベント。`add()` のたびに (重複抑制で toast を追加しなかった場合も)
 * 更新される。purpose は「toast の表示有無」ではなく「通知の発生そのもの」を観測したい
 * 購読者向け (例: arcade の error 演出)。`notifications` の length / 配列内容は重複抑制で
 * 動かないことがあるため、発生イベントはこの専用シグナルで配る。seq で同一 type の連続発火も
 * 区別できるようにする。
 */
interface NotifyEvent {
  type: Notification["type"];
  seq: number;
}
let eventSeq = 0;
const lastEvent = ref<NotifyEvent | undefined>(undefined);

const CONSOLE_BY_TYPE = {
  error: console.error,
  warning: console.warn,
  info: console.info,
} as const;

/**
 * 同一メッセージの重複を抑制する。既に表示中ならトーストは追加せず、cause だけ最新で上書きする。
 * cause を上書きするのは、ユーザーが Copy する詳細を最新の発生時点に揃えるため。
 */
function add(type: Notification["type"], message: string, cause?: unknown) {
  CONSOLE_BY_TYPE[type](message, ...(cause !== undefined ? [cause] : []));

  // 発生イベントは toast の表示有無と独立に毎回配る (重複抑制で toast を足さない場合も含む)
  lastEvent.value = { type, seq: ++eventSeq };

  const duplicate = notifications.value.find((n) => n.type === type && n.message === message);
  if (duplicate) {
    duplicate.cause = cause;
    return;
  }

  notifications.value.push({ id: nextId++, type, message, cause });
}

function dismiss(id: number) {
  notifications.value = notifications.value.filter((n) => n.id !== id);
}

/**
 * 観測専用の log を出す。toast には載せず console.debug にだけ出力する。
 * 「ユーザーには見せたくないが dev tools での切り分けには使いたい」用途
 * (state machine の no-op 経路、低頻度の境界条件) を notification store 経由に
 * 集約することで、CLAUDE.md「呼び出し側で console を直書きしない」規約と整合させる。
 */
function debug(message: string, payload?: unknown) {
  console.debug(message, ...(payload !== undefined ? [payload] : []));
}

export function useNotificationStore() {
  return {
    notifications,
    lastEvent,
    error: (message: string, cause?: unknown) => add("error", message, cause),
    warning: (message: string, cause?: unknown) => add("warning", message, cause),
    info: (message: string, cause?: unknown) => add("info", message, cause),
    debug,
    dismiss,
  };
}
