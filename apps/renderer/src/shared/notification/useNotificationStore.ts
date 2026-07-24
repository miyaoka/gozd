/**
 * 通知ストア。module singleton パターン。
 * toast と notification center の共有 SSOT。通知リストは 1 本で、toast はその view
 * (`toastVisible` な項目のみ)。auto-dismiss / 手動 dismiss は toast の表示を畳むだけで
 * 項目は center に残り、項目の削除は center 側の `remove` / `clear` だけが行う
 * (VS Code の toasts / notification center と同じ分業。auto-dismiss が silent drop に
 * ならないのは center という受け皿があるため)。
 *
 * 通知は毎回独立項目で、集約 (重複抑制) はしない (VS Code と同じ)。message 文字列での
 * 暗黙グルーピングは別発生源の同文言が誤結合し、message に可変部を入れると誤分裂する
 * 二方向の欠陥があるため採らない。
 *
 * toast の永続化 (自動消去しない) の軸は重大度 (type) ではなく「ユーザーが画面を見て
 * いるか」: ユーザー操作への応答 (Copied 等の確認) は目撃済みなので自動消去し、
 * ユーザー操作を伴わず background で発火する must-see 通知 (背景 fetch の失敗等) は
 * `persist` opt-in で手動クローズまで残す。error は常に永続。
 *
 * `error` / `warning` / `info` は toast 表示 + console 出力、`debug` は **console.debug への
 * 集約窓口**で toast 表示なし。renderer 規約 (CLAUDE.md エラーハンドリング) で
 * 「呼び出し側で console を直書きしない (store 経由)」方針を満たすため、
 * 切り分け用 log もこの store 経由で発火する。
 */
import { computed, ref } from "vue";

export interface Notification {
  id: number;
  type: "error" | "warning" | "info";
  message: string;
  cause?: unknown;
  /** 発生時刻 (epoch ms) */
  at: number;
  /** 通知発生順の単調増加値。center の未読判定 / 新着順ソートに使う */
  seq: number;
  persist: boolean;
  /** toast として表示中か。false は center にのみ残る */
  toastVisible: boolean;
}

/** persist しない warning / info toast の自動消去時間（ms） */
const AUTO_DISMISS_MS = 5000;
/** center に保持する通知数の上限。超過分は古い順に落とす */
export const MAX_NOTIFICATIONS = 100;

interface NotifyOptions {
  /** true でユーザーが閉じるまで toast を残す。background 発火の must-see 通知用（ヘッダコメント参照） */
  persist?: boolean;
}

let nextId = 0;
const notifications = ref<Notification[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** toast として表示中の項目だけの view (NotificationToast が購読)。 */
const toasts = computed(() => notifications.value.filter((n) => n.toastVisible));

/**
 * 最後に発火した通知イベント。`add()` のたびに更新される。purpose は「toast の表示有無」
 * ではなく「通知の発生そのもの」を観測したい購読者向け (例: arcade の error 演出)。
 * seq で同一 type の連続発火も区別できるようにする。
 */
interface NotifyEvent {
  type: Notification["type"];
  seq: number;
}
let eventSeq = 0;
const lastEvent = ref<NotifyEvent | undefined>(undefined);

// メソッド名だけ持ち、呼び出し時に console から引く。関数参照を module load 時に
// 束縛すると、テストの spyOn (プロパティ差し替え) が効かず出力を黙らせられない
const CONSOLE_METHOD_BY_TYPE = {
  error: "error",
  warning: "warn",
  info: "info",
} as const satisfies Record<Notification["type"], keyof Console>;

function add(type: Notification["type"], message: string, cause?: unknown, opts?: NotifyOptions) {
  console[CONSOLE_METHOD_BY_TYPE[type]](message, ...(cause !== undefined ? [cause] : []));

  lastEvent.value = { type, seq: ++eventSeq };

  const persistRequested = type === "error" || opts?.persist === true;

  const id = nextId++;
  notifications.value.push({
    id,
    type,
    message,
    cause,
    at: Date.now(),
    seq: eventSeq,
    persist: persistRequested,
    toastVisible: true,
  });

  // 上限超過は古い項目から落とす (persist でも落とす。100 件溜まる時点で異常系であり、
  // 表示保護より上限保証を優先する)。項目は追加のみで並び替えないため配列先頭 = 最古
  const overflow = notifications.value.length - MAX_NOTIFICATIONS;
  if (overflow > 0) {
    for (const dropped of notifications.value.slice(0, overflow)) {
      clearTimer(dropped.id);
    }
    notifications.value = notifications.value.slice(overflow);
  }

  if (!persistRequested) {
    timers.set(
      id,
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
    );
  }
}

function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

/** toast を畳む。項目は center に残る。 */
function dismiss(id: number) {
  clearTimer(id);
  const notification = notifications.value.find((n) => n.id === id);
  if (!notification) return;
  notification.toastVisible = false;
}

/** 項目を center から削除する (toast 表示中なら toast も消える)。 */
function remove(id: number) {
  clearTimer(id);
  notifications.value = notifications.value.filter((n) => n.id !== id);
}

/** 全項目を削除する。 */
function clear() {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
  notifications.value = [];
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
    toasts,
    lastEvent,
    error: (message: string, cause?: unknown) => add("error", message, cause),
    warning: (message: string, cause?: unknown, opts?: NotifyOptions) =>
      add("warning", message, cause, opts),
    info: (message: string, cause?: unknown, opts?: NotifyOptions) =>
      add("info", message, cause, opts),
    debug,
    dismiss,
    remove,
    clear,
  };
}
