import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { tryCatch } from "@gozd/shared";
import { onMessage } from "../../shared/rpc";
import {
  rpcServerList,
  rpcWindowSetServerPanelOpen,
  type ServerInfo,
  type ServerPortsChangePayload,
  serversFromPayload,
} from "./rpc";

/**
 * 実行中サーバー (TCP LISTEN プロセス) の検出結果と一覧パネルの開閉を集約する SSOT
 * (issue #768)。
 *
 * データ経路:
 *   - mount 時に `/server/list` を pull して hydrate (HMR リロード後の再水和も担う)
 *   - native の `serverPortsChange` push で全件 snapshot を latest-wins 置換
 *
 * パネル開閉:
 *   - 開閉状態はこの store が SSOT として所有する
 *   - native titlebar のトグルボタンは `toggleServerPanel` push で `toggle()` を叩く
 *   - `isOpen` の変化を `/window/setServerPanelOpen` で native にミラーし、ボタンの
 *     active 表示 (塗り) を同期する (TitleContext と同流儀)
 */
export const useServerStore = defineStore("server", () => {
  const servers = ref<ServerInfo[]>([]);
  const isOpen = ref(false);

  // mount 時の初回 hydrate。push が来るまでの空白を埋める。
  void hydrate();
  async function hydrate() {
    const result = await tryCatch(rpcServerList());
    if (result.ok) servers.value = result.value;
  }

  // 全件 snapshot push。差分ではなく毎回全件なので latest-wins で置換する。
  onMessage<ServerPortsChangePayload>("serverPortsChange", (payload) => {
    servers.value = serversFromPayload(payload);
  });

  // titlebar トグルボタンからの開閉要求。
  onMessage<Record<string, never>>("toggleServerPanel", () => {
    toggle();
  });

  // 開閉状態を native の ToolbarItem 表示にミラーする。初期値の push は不要
  // (native 側も false 初期化済み)。
  watch(isOpen, (open) => {
    void tryCatch(rpcWindowSetServerPanelOpen(open));
  });

  function open(): void {
    isOpen.value = true;
  }
  function close(): void {
    isOpen.value = false;
  }
  function toggle(): void {
    isOpen.value = !isOpen.value;
  }

  /**
   * 指定 worktree path で「実際にその worktree のターミナルで動いている」サーバーの
   * port 群 (昇順・重複なし)。サイドバーのバッジ表示に使う。orphaned (ターミナル消滅後)
   * は worktree の現役サーバーではないため含めない。
   */
  function livePortsByWorktree(worktreePath: string): number[] {
    const ports = new Set<number>();
    for (const server of servers.value) {
      if (server.attribution !== "live") continue;
      if (server.worktreePath !== worktreePath) continue;
      for (const port of server.ports) ports.add(port);
    }
    return [...ports].sort((a, b) => a - b);
  }

  /** 検出済みサーバーが 1 つでもあるか (パネル空表示の出し分け用)。 */
  const hasServers = computed(() => servers.value.length > 0);

  return {
    servers,
    isOpen,
    hasServers,
    open,
    close,
    toggle,
    livePortsByWorktree,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useServerStore, import.meta.hot));
}
