// main（watcherClient）↔ utilityProcess（watcherProcess）間の message 契約。
// 純粋な型のみ（runtime 依存なし）。両端が同型を参照して JSON 相当の構造化 message を交換する。
//
// 隔離の目的: @parcel/watcher の native FSEvents コールバックスレッドが heap 破壊で
// trap しても、別プロセス（別アドレス空間）に閉じ込めて main を巻き込まないこと。
// そのため utilityProcess 側は subscribe だけを持ち、classify / git / push は main に残す。

/** main → watcher: 監視の開始 / 停止。id は subscription 単位で main が採番する */
export type HostToWatcherMessage =
  | { type: "subscribe"; id: number; root: string; ignore: string[] }
  | { type: "unsubscribe"; id: number };

/** watcher → main: ack / event / エラー / ログ。
 * ack・event・error は id で subscription に紐づく。log は隔離プロセス内部の観測ログで、
 * main が event-log（logEvent）へ転送する（VS Code の onDidLogMessage 相当。stderr は
 * packaged で見えないため使わない） */
export type WatcherToHostMessage =
  | { type: "subscribed"; id: number }
  | { type: "subscribeError"; id: number; message: string }
  | { type: "events"; id: number; paths: string[] }
  | { type: "watchError"; id: number; message: string }
  | { type: "log"; channel: string; label: string; detail: string };
