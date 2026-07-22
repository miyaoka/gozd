/**
 * 通知ストア。module singleton パターン。
 * toast と notification center の共有 SSOT。通知リストは 1 本で、toast はその view
 * (`toastVisible` な項目のみ)。auto-dismiss / 手動 dismiss は toast の表示を畳むだけで
 * 項目は center に残り、項目の削除は center 側の `remove` / `clear` だけが行う
 * (VS Code の toasts / notification center と同じ分業。auto-dismiss が silent drop に
 * ならないのは center という受け皿があるため)。
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
  /** 最新の発生時刻 (epoch ms)。重複抑制時は最新発生で上書きする */
  at: number;
  /** 同一通知の累計発生回数 (重複抑制で加算) */
  count: number;
  /** 通知発生順の単調増加値。重複抑制時も更新され、center の未読判定 / 新着順ソートに使う */
  seq: number;
  persist: boolean;
  /** toast として表示中か。false は center にのみ残る */
  toastVisible: boolean;
}

/** persist しない warning / info toast の自動消去時間（ms） */
const AUTO_DISMISS_MS = 5000;
/** center に保持する通知数の上限。超過分は最終発生が古い順 (seq 昇順) に落とす */
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
 * 同一 type + message は重複抑制で 1 項目に集約する。既存項目の cause / at / seq を最新の
 * 発生時点に更新して count を加算し、toast を再表示する (dismiss 済みでも新しい発生は
 * 新しい観測なので toast を出し直し、非 persist なら timer も張り直す)。
 * persist は昇格のみ反映する: 表示中の must-see を後発の非 persist 要求が短縮すると
 * silent drop に戻るため、降格はしない。
 */
function add(type: Notification["type"], message: string, cause?: unknown, opts?: NotifyOptions) {
  CONSOLE_BY_TYPE[type](message, ...(cause !== undefined ? [cause] : []));

  // 発生イベントは toast の表示有無と独立に毎回配る (重複抑制で toast を足さない場合も含む)
  lastEvent.value = { type, seq: ++eventSeq };

  const persistRequested = type === "error" || opts?.persist === true;

  const duplicate = notifications.value.find((n) => n.type === type && n.message === message);
  if (duplicate) {
    duplicate.cause = cause;
    duplicate.at = Date.now();
    duplicate.count += 1;
    duplicate.seq = eventSeq;
    duplicate.persist = duplicate.persist || persistRequested;
    duplicate.toastVisible = true;
    clearTimer(duplicate.id);
    if (!duplicate.persist) {
      timers.set(
        duplicate.id,
        setTimeout(() => dismiss(duplicate.id), AUTO_DISMISS_MS),
      );
    }
    return;
  }

  const id = nextId++;
  notifications.value.push({
    id,
    type,
    message,
    cause,
    at: Date.now(),
    count: 1,
    seq: eventSeq,
    persist: persistRequested,
    toastVisible: true,
  });

  // 上限超過は最終発生が最も古い項目 (最小 seq) から落とす (persist でも落とす。100 件
  // 溜まる時点で異常系であり、表示保護より上限保証を優先する)。配列位置 = 初回発生順を
  // 基準にすると、重複抑制で in-place 更新され続ける再発火中の must-see (背景 fetch 失敗等)
  // が先頭に居座ったまま最優先で消えるため、seq (最新発生順) を基準にする
  const overflow = notifications.value.length - MAX_NOTIFICATIONS;
  if (overflow > 0) {
    const dropIds = new Set(
      [...notifications.value]
        .sort((a, b) => a.seq - b.seq)
        .slice(0, overflow)
        .map((n) => n.id),
    );
    for (const dropId of dropIds) clearTimer(dropId);
    notifications.value = notifications.value.filter((n) => !dropIds.has(n.id));
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
