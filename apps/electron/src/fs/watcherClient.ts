// main 側 host。@parcel/watcher を隔離した utilityProcess（watcherProcess.cjs）を起動し、
// fsWatchRegistry の WatchTransport 契約を満たす。
//
// crash 復帰が本モジュールの主眼: native watcher プロセスが落ちても（隔離の目的）、
// exit を検知して respawn し、確立済み subscription を全て再確立する。落ちたまま黙って
// 監視が止まると gozd の「push を落とさない」規律が破れるため、respawn と観察ログは必須。
// VS Code の UniversalWatcherClient（utilityProcess worker + onDidTerminate 再init）と同型。

import { utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import type { WatchHandle, WatchTransport } from "./fsWatchRegistry";
import type { HostToWatcherMessage, WatcherToHostMessage } from "./watcherProtocol";

/** 連続 crash で respawn ループに陥るのを防ぐ上限。健全な message 受信でリセットする。
 * 起動直後に必ず落ちる病的ケース（poison root 等）で無限 fork を止める backstop */
const MAX_CONSECUTIVE_RESPAWNS = 5;

interface Subscription {
  root: string;
  ignore: string[];
  onEvents: (paths: string[]) => void;
  onError: (message: string) => void;
}

export interface WatcherClientDeps {
  /** 診断イベント（crash / respawn / 隔離プロセス内部ログ）を event-log パネルへ流す。
   * routes 側で `debugLog` push に変換する。VS Code の Output ログチャンネル相当で、
   * 自己修復する crash はここ止まり（toast にしない） */
  logEvent: (channel: string, label: string, detail: string) => void;
  /** ユーザーが行動すべき terminal な事象（監視が完全停止 → 要再起動）だけをトースト通知する */
  notify: (message: string, detail: string) => void;
}

export interface WatcherClient extends WatchTransport {
  /** app 終了時に utilityProcess を停止する（意図的終了。respawn しない） */
  dispose(): void;
}

export function createWatcherClient(deps: WatcherClientDeps): WatcherClient {
  const { logEvent, notify } = deps;
  // dev / packaged いずれも __dirname は dist を指すため分岐不要（build.ts が
  // dist/watcherProcess.cjs に出力。gozdEnv 調査より）
  const scriptPath = join(__dirname, "watcherProcess.cjs");

  let child: UtilityProcess | undefined;
  let ready: Promise<UtilityProcess> | undefined;
  let disposing = false;
  let nextId = 0;
  let respawnCount = 0;

  // 確立済み（ack 受信済み）の subscription のみ保持。respawn 時の再確立対象
  const live = new Map<number, Subscription>();
  // subscribe ack 待ち。resolve/reject を id で相関する
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

  function onMessage(message: WatcherToHostMessage): void {
    // 健全な message 受信 = プロセスは生きている。respawn backstop をリセット
    respawnCount = 0;
    switch (message.type) {
      case "subscribed":
        pending.get(message.id)?.resolve();
        pending.delete(message.id);
        break;
      case "subscribeError":
        pending.get(message.id)?.reject(new Error(message.message));
        pending.delete(message.id);
        break;
      case "events":
        live.get(message.id)?.onEvents(message.paths);
        break;
      case "watchError":
        live.get(message.id)?.onError(message.message);
        break;
      case "log":
        // 隔離プロセス内部の観測ログを event-log へ転送する
        logEvent(message.channel, message.label, message.detail);
        break;
    }
  }

  function onExit(code: number): void {
    child = undefined;
    ready = undefined;
    // in-flight の subscribe を reject して awaiter（buildEntry）を解放する。
    // 確立前なので live には入っておらず、respawn 対象からも外れる
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`watcher process exited (code=${code})`));
    }
    pending.clear();

    if (disposing || live.size === 0) return;

    respawnCount++;
    if (respawnCount > MAX_CONSECUTIVE_RESPAWNS) {
      // terminal かつ行動可能（要再起動）なのでトースト通知する。診断用にも残す
      notify(
        "File watching stopped",
        `The file watcher crashed ${respawnCount} times in a row; ${live.size} watchers are down. Restart the app to resume watching.`,
      );
      logEvent("file-watcher", "gave-up", `crashed ${respawnCount}x consecutively; ${live.size} watchers down`);
      return;
    }
    // crash → 自己修復。行動不要なので toast にせず event-log だけに残す（VS Code と同じ）
    logEvent(
      "file-watcher",
      "crashed",
      `process exited (code=${code}); resubscribing ${live.size} watchers (attempt ${respawnCount})`,
    );
    // sendSubscribe は非同期で、失敗時の live.delete は await 後の .catch で走る。
    // 同期 for-of 中に live は変化しないためコピー不要
    for (const [id, sub] of live) {
      void sendSubscribe(id, sub).catch((error: unknown) => {
        live.delete(id);
        logEvent("file-watcher", "resubscribe-failed", `${sub.root}: ${String(error)}`);
        sub.onError(String(error));
      });
    }
  }

  function getChild(): Promise<UtilityProcess> {
    if (ready !== undefined) return ready;
    ready = new Promise((resolve) => {
      const spawned = utilityProcess.fork(scriptPath, [], { serviceName: "gozd-file-watcher" });
      spawned.on("message", onMessage);
      spawned.on("exit", onExit);
      // postMessage は spawn 完了前だと取りこぼす可能性があるため spawn を待ってから解決する
      spawned.on("spawn", () => resolve(spawned));
      child = spawned;
    });
    return ready;
  }

  async function sendSubscribe(id: number, sub: Subscription): Promise<void> {
    const proc = await getChild();
    const ack = new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    proc.postMessage({
      type: "subscribe",
      id,
      root: sub.root,
      ignore: sub.ignore,
    } satisfies HostToWatcherMessage);
    await ack;
  }

  async function subscribe(
    root: string,
    ignore: string[],
    onEvents: (paths: string[]) => void,
    onError: (message: string) => void,
  ): Promise<WatchHandle> {
    const id = nextId++;
    const sub: Subscription = { root, ignore, onEvents, onError };
    // ack 前に crash / subscribeError なら throw され、live には入らない（buildEntry が巻き戻す）
    await sendSubscribe(id, sub);
    live.set(id, sub);
    return {
      unsubscribe: async () => {
        if (!live.delete(id)) return;
        // プロセスが落ちている間の unsubscribe は no-op（respawn 対象から live.delete で外れる）
        child?.postMessage({ type: "unsubscribe", id } satisfies HostToWatcherMessage);
      },
    };
  }

  function dispose(): void {
    disposing = true;
    live.clear();
    const proc = child;
    child = undefined;
    ready = undefined;
    proc?.kill();
  }

  return { subscribe, dispose };
}
