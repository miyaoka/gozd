/**
 * main プロセス発の `debugLog` push を購読し、renderer の event-log（logEvent）に載せる。
 *
 * shared/rpc と shared/debug の橋渡し。shared 間の依存は禁じられているため、上位層
 * （layout feature）でこの bridge を組む（useNotifySubscription と同型）。
 *
 * 用途: utilityProcess に隔離した watcher の crash/respawn 等、main 側で起きる観測イベントを
 * renderer の EventLogPanel に流す。VS Code が隔離 watcher の onDidLogMessage を client の
 * logger に転送するのと同じ経路を、gozd では main→renderer push で実現する。
 */
import { onMounted, onUnmounted } from "vue";
import { logEvent } from "../../shared/debug";
import type { DebugLogPayload } from "../../shared/debug";
import { onMessage } from "../../shared/rpc";

export function useMainDebugSubscription() {
  let dispose: (() => void) | undefined;
  onMounted(() => {
    dispose = onMessage<DebugLogPayload>("debugLog", ({ channel, label, repo, detail }) => {
      logEvent(channel, label, repo, detail);
    });
  });
  onUnmounted(() => {
    dispose?.();
  });
}
