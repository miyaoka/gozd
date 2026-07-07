// Electron utilityProcess のエントリ。@parcel/watcher の subscribe だけを持つ。
//
// なぜ別プロセスか: @parcel/watcher の native FSEvents コールバックスレッドが
// `Watcher::isIgnored` 内で heap 破壊 → `brk 0` trap すると、in-process では main ごと
// 落ちる（Electron の renderer/GPU 隔離は addon を main に同居させるため効かない）。
// subscribe を別プロセス（別アドレス空間）に閉じ込め、crash はこのプロセスだけで完結させる。
// classify / git / push は main（watcherClient の呼び出し側）に残し、ここは native 監視のみ。
//
// build.ts が `@parcel/watcher` を external にして dist/watcherProcess.cjs に bundle する
// （.node バイナリは実行時 require、node_modules から解決）。

import { subscribe, type AsyncSubscription } from "@parcel/watcher";
import { tryCatch } from "@gozd/shared";
import type { HostToWatcherMessage, WatcherToHostMessage } from "./watcherProtocol";

// utilityProcess 内でのみ parentPort が生える。それ以外での誤起動は起動元がいないので即死
const parentPort = process.parentPort;

const subscriptions = new Map<number, AsyncSubscription>();
// subscribe が解決する前に unsubscribe が届いた id。解決時に即解放して leak を防ぐ
const cancelledBeforeReady = new Set<number>();

function post(message: WatcherToHostMessage): void {
  parentPort.postMessage(message);
}

async function handleSubscribe(id: number, root: string, ignore: string[]): Promise<void> {
  const result = await tryCatch(
    subscribe(
      root,
      (err, events) => {
        if (err !== null) {
          post({ type: "watchError", id, message: String(err) });
          return;
        }
        post({ type: "events", id, paths: events.map((event) => event.path) });
      },
      ignore.length > 0 ? { ignore } : undefined,
    ),
  );
  if (!result.ok) {
    post({ type: "subscribeError", id, message: String(result.error) });
    return;
  }
  if (cancelledBeforeReady.delete(id)) {
    // subscribe 解決前に unsubscribe 済み。ack を返さず即解放する。unsubscribe の reject を
    // 握らないと unhandled rejection でこのプロセスごと落ち respawn を誘発するため tryCatch で包む
    const released = await tryCatch(result.value.unsubscribe());
    if (!released.ok) {
      post({
        type: "log",
        channel: "file-watcher",
        label: "unsubscribe-failed",
        detail: `id=${id}: ${String(released.error)}`,
      });
    }
    return;
  }
  subscriptions.set(id, result.value);
  post({ type: "subscribed", id });
}

async function handleUnsubscribe(id: number): Promise<void> {
  const sub = subscriptions.get(id);
  if (sub === undefined) {
    // subscribe が in-flight の可能性。解決時に解放させる
    cancelledBeforeReady.add(id);
    return;
  }
  subscriptions.delete(id);
  const result = await tryCatch(sub.unsubscribe());
  if (!result.ok) {
    // stderr は packaged で見えないため log message で main → event-log に転送する
    post({
      type: "log",
      channel: "file-watcher",
      label: "unsubscribe-failed",
      detail: `id=${id}: ${String(result.error)}`,
    });
  }
}

parentPort.on("message", (event) => {
  const message = event.data as HostToWatcherMessage;
  if (message.type === "subscribe") {
    void handleSubscribe(message.id, message.root, message.ignore);
    return;
  }
  void handleUnsubscribe(message.id);
});
