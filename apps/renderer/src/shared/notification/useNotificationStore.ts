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
 * toast は全 type とも自動消去し、寿命だけを severity に比例させる (VS Code の
 * PURGE_TIMEOUT と同値: info 10s / warning 12s / error 15s)。ただし VS Code の purge
 * ガードと同じく、hover / キーボードフォーカス中 (hold) と window blur 中 (suspend) は
 * 消去を保留し、解除時にフル時間で張り直す。手動クローズを要求する sticky 相当は
 * 持たない: VS Code で sticky になるのはドメイン操作を実行する primary action 付き
 * error / progress 付き通知だが、gozd の通知はどちらも持たない (Details / Dismiss は
 * toast 自身の操作であり primary action ではない)。見逃しは center が受け皿として回収する。
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
  /** toast として表示中か。false は center にのみ残る */
  toastVisible: boolean;
}

/** type 別の toast 自動消去時間（ms）。VS Code の PURGE_TIMEOUT と同値 */
const AUTO_DISMISS_MS_BY_TYPE = {
  info: 10_000,
  warning: 12_000,
  error: 15_000,
} as const satisfies Record<Notification["type"], number>;
/** center に保持する通知数の上限。超過分は古い順に落とす */
export const MAX_NOTIFICATIONS = 100;
/**
 * 同時に描画する toast の上限 (VS Code の notificationsToasts MAX_NOTIFICATIONS と同値)。
 * blur suspend 中に通知が溜まっても、復帰時に画面が toast で埋まらないための上限。
 * 新しい通知ほど重要なので末尾 (最新) 側を採る。超過分は toastVisible のまま待機し、
 * 枠が空くと古い側から繰り上がって表示される。寿命は生成時から進むため、繰り上がった
 * toast は残り時間ぶんしか表示されず、枠が空かないまま寿命が尽きた通知は一度も表示
 * されずに center にのみ残る (可視化時点でタイマーを張る VS Code 方式は可視集合の
 * 出入り監視が要るため採らない。center が受け皿にあるため取りこぼしにはならない)
 */
const MAX_VISIBLE_TOASTS = 3;

let nextId = 0;
const notifications = ref<Notification[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/** id → 自動消去を保留している理由の集合 (hover / キーボードフォーカス) */
const holds = new Map<number, Set<string>>();
/** window blur 中の全 toast 一括保留 (VS Code の onDidChangeFocus 相当) */
let autoDismissSuspended = false;

/** toast として表示中の項目のうち最新 MAX_VISIBLE_TOASTS 件の view (NotificationToast が購読)。 */
const toasts = computed(() =>
  notifications.value.filter((n) => n.toastVisible).slice(-MAX_VISIBLE_TOASTS),
);

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

function add(type: Notification["type"], message: string, cause?: unknown) {
  console[CONSOLE_METHOD_BY_TYPE[type]](message, ...(cause !== undefined ? [cause] : []));

  lastEvent.value = { type, seq: ++eventSeq };

  const id = nextId++;
  notifications.value.push({
    id,
    type,
    message,
    cause,
    at: Date.now(),
    seq: eventSeq,
    toastVisible: true,
  });

  // 上限超過は古い項目から落とす (未読でも落とす。長時間の連続失敗では平常運転でも到達
  // しうるが、受け皿の完全性より資源の上限保証を優先する設計判断)。項目は追加のみで
  // 並び替えないため配列先頭 = 最古
  const overflow = notifications.value.length - MAX_NOTIFICATIONS;
  if (overflow > 0) {
    for (const dropped of notifications.value.slice(0, overflow)) {
      clearTimer(dropped.id);
      holds.delete(dropped.id);
    }
    notifications.value = notifications.value.slice(overflow);
  }

  scheduleAutoDismiss(id, type);
}

function isHeld(id: number): boolean {
  if (autoDismissSuspended) return true;
  const reasons = holds.get(id);
  return reasons !== undefined && reasons.size > 0;
}

function scheduleAutoDismiss(id: number, type: Notification["type"]) {
  timers.set(
    id,
    setTimeout(() => {
      // VS Code の purgeNotification と同じく、発火時に保留中なら消さずフル時間で張り直す
      // (解除イベント側の再スケジュールと二重の防御。競合しても消えるのが遅れるだけ)
      if (isHeld(id)) {
        scheduleAutoDismiss(id, type);
        return;
      }
      dismiss(id);
    }, AUTO_DISMISS_MS_BY_TYPE[type]),
  );
}

function rescheduleIfReleased(id: number) {
  if (isHeld(id)) return;
  const notification = notifications.value.find((n) => n.id === id);
  if (!notification || !notification.toastVisible) return;
  clearTimer(id);
  scheduleAutoDismiss(id, notification.type);
}

/** toast の自動消去を保留する。hover / キーボードフォーカス中の消失を防ぐ (VS Code と同じガード) */
function holdToast(id: number, reason: string) {
  const reasons = holds.get(id) ?? new Set<string>();
  reasons.add(reason);
  holds.set(id, reasons);
}

/** hold を解除し、保留理由が無くなったらフル時間で自動消去を張り直す */
function releaseToast(id: number, reason: string) {
  const reasons = holds.get(id);
  if (reasons === undefined) return;
  reasons.delete(reason);
  if (reasons.size === 0) holds.delete(id);
  rescheduleIfReleased(id);
}

/** window blur 中は全 toast の自動消去を保留し、focus 復帰でフル時間から再開する */
function setAutoDismissSuspended(suspended: boolean) {
  autoDismissSuspended = suspended;
  if (suspended) return;
  for (const n of notifications.value) {
    if (n.toastVisible) rescheduleIfReleased(n.id);
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
  holds.delete(id);
  const notification = notifications.value.find((n) => n.id === id);
  if (!notification) return;
  notification.toastVisible = false;
}

/**
 * 表示中の全 toast を畳む (可視上限で隠れている待機分も含む)。項目は center に残る。
 * 可視上限は view の都合であり、「畳む」操作の対象は toastVisible 集合の全件。
 */
function dismissAllToasts() {
  for (const n of notifications.value) {
    if (n.toastVisible) dismiss(n.id);
  }
}

/** 項目を center から削除する (toast 表示中なら toast も消える)。 */
function remove(id: number) {
  clearTimer(id);
  holds.delete(id);
  notifications.value = notifications.value.filter((n) => n.id !== id);
}

/** 全項目を削除する。 */
function clear() {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
  holds.clear();
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
    warning: (message: string, cause?: unknown) => add("warning", message, cause),
    info: (message: string, cause?: unknown) => add("info", message, cause),
    debug,
    dismiss,
    dismissAllToasts,
    remove,
    clear,
    holdToast,
    releaseToast,
    setAutoDismissSuspended,
  };
}
