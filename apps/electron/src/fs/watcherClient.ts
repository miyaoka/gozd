// main 側 host。@parcel/watcher を隔離した utilityProcess（watcherProcess.cjs）を起動し、
// fsWatchRegistry の WatchTransport 契約を満たす。
//
// crash 復帰が本モジュールの主眼: native watcher プロセスが落ちても（隔離の目的）、
// exit を検知して respawn し、確立済み subscription を全て再確立する。落ちたまま黙って
// 監視が止まると gozd の「push を落とさない」規律が破れるため、respawn と観察は必須。
// VS Code の UniversalWatcherClient（utilityProcess worker + onDidTerminate 再init）と同型。

import type { UtilityProcess } from "electron";
import { join } from "node:path";
import type { WatchHandle, WatchTransport } from "./fsWatchRegistry";
import type { HostToWatcherMessage, WatcherToHostMessage } from "./watcherProtocol";

/** backstop の観測窓と上限。窓内でこの回数を超えて crash したら「監視が完全停止した」と
 * みなして respawn を止め、ユーザーに再起動を促す。連続回数ではなく時間窓にするのは、
 * subscribe を ack できる steady-state crash（初期 crawl は通り後段で crash）も terminal と
 * 判定するため（連続カウントだと ack のたびにリセットされ永遠に到達しない） */
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 5;

interface Subscription {
  root: string;
  ignore: string[];
  onEvents: (paths: string[]) => void;
  onError: (message: string) => void;
}

/** utilityProcess.fork の seam。production は electron、テストは fake process を注入する。 */
type ForkWatcherProcess = (scriptPath: string) => UtilityProcess;

export interface WatcherClientDeps {
  /** 診断イベント（crash / respawn / 隔離プロセス内部ログ）を event-log パネルへ流す。
   * routes 側で `debugLog` push に変換する。VS Code の Output ログチャンネル相当で、
   * 自己修復する crash はここ止まり（toast にしない） */
  logEvent: (channel: string, label: string, detail: string) => void;
  /** ユーザーが行動すべき terminal な事象（監視が完全停止 → 要再起動）だけをトースト通知する */
  notify: (message: string, detail: string) => void;
  /** test 用 seam。省略時は electron の utilityProcess.fork（遅延 require で bun test の
   * electron load を避ける） */
  fork?: ForkWatcherProcess;
  /** test 用 seam。時間窓 backstop 用の時計。省略時は Date.now */
  clock?: () => number;
}

export interface WatcherClient extends WatchTransport {
  /** app 終了時に utilityProcess を停止する（意図的終了。respawn しない） */
  dispose(): void;
}

export function createWatcherClient(deps: WatcherClientDeps): WatcherClient {
  const { logEvent, notify } = deps;
  const clock = deps.clock ?? (() => Date.now());
  // 遅延 require で electron の値 import を実行時まで先送りする（top-level import だと bun test
  // が watcherClient を読むだけで electron load に失敗するため）。テストは fork を注入し、この
  // 既定経路を通らない
  const fork: ForkWatcherProcess =
    deps.fork ??
    ((path) =>
      (require("electron") as typeof import("electron")).utilityProcess.fork(path, [], {
        serviceName: "gozd-file-watcher",
      }));
  // dev / packaged いずれも __dirname は dist を指すため分岐不要（build.ts が
  // dist/watcherProcess.cjs に出力。gozdEnv 調査より）
  const scriptPath = join(__dirname, "watcherProcess.cjs");

  let child: UtilityProcess | undefined;
  let ready: Promise<UtilityProcess> | undefined;
  // spawn 完了前に process が exit したら getChild を hang させず reject するための保持
  let readyReject: ((error: Error) => void) | undefined;
  let disposing = false;
  let nextId = 0;
  // 各 onExit の respawn 試行に採番する世代。resubscribe の stale な .catch が新しい試行の
  // 再確立を巻き戻すのを防ぐ（fsWatchRegistry の generation ガードと同じ idiom）
  let respawnEpoch = 0;
  // 時間窓内の crash 時刻。窓外は都度捨てる
  let crashTimestamps: number[] = [];

  // 確立済み（ack 受信済み）の subscription のみ保持。respawn 時の再確立対象
  const live = new Map<number, Subscription>();
  // subscribe ack 待ち。resolve/reject を id で相関する
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

  function onMessage(message: WatcherToHostMessage): void {
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
    // spawn 完了前の exit なら getChild の promise を reject し、await 中の buildEntry が
    // 永久に hang するのを防ぐ
    const rejectSpawn = readyReject;
    readyReject = undefined;
    rejectSpawn?.(new Error(`watcher process exited before spawn (code=${code})`));
    // in-flight の subscribe を reject して awaiter を解放する。確立前なので live には入って
    // おらず、respawn 対象からも外れる
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`watcher process exited (code=${code})`));
    }
    pending.clear();

    if (disposing || live.size === 0) return;

    // 時間窓 backstop: 窓内 crash 回数が上限を超えたら respawn を止め、terminal として通知する
    const now = clock();
    crashTimestamps.push(now);
    crashTimestamps = crashTimestamps.filter((t) => now - t <= CRASH_WINDOW_MS);
    if (crashTimestamps.length > MAX_CRASHES_IN_WINDOW) {
      // terminal かつ行動可能（要再起動）なのでトースト通知する。診断用にも残す
      notify(
        "File watching stopped",
        `The file watcher crashed ${crashTimestamps.length} times within ${CRASH_WINDOW_MS / 1000}s; ${live.size} watchers are down. Restart the app to resume watching.`,
      );
      logEvent(
        "file-watcher",
        "gave-up",
        `${crashTimestamps.length} crashes within ${CRASH_WINDOW_MS / 1000}s; ${live.size} watchers down`,
      );
      // 世代を進めて直前の respawn の resubscribe catch を stale 化する。これをしないと
      // その catch が epoch 一致のまま走り、下の onError と二重に onError を撃つ（ログ重複）
      respawnEpoch++;
      // give-up は terminal。呼び出し側（fsWatchRegistry）に各 watch の死亡を伝え、live を
      // 空にする。残すと後続の無関係な crash の respawn が give-up 済み subscription を巻き込んで
      // 再 subscribe し、「要再起動」通知と矛盾するため
      for (const sub of live.values()) {
        sub.onError("file watching stopped after repeated crashes");
      }
      live.clear();
      return;
    }
    // crash → 自己修復。行動不要なので toast にせず event-log だけに残す（VS Code と同じ）
    logEvent(
      "file-watcher",
      "crashed",
      `process exited (code=${code}); resubscribing ${live.size} watchers`,
    );
    // この onExit の respawn 世代を採番。resubscribe の .catch はこの世代が最新のときだけ
    // live を触る。二重 crash で新しい onExit が始まると古い試行の catch は no-op になる
    respawnEpoch++;
    const epoch = respawnEpoch;
    // sendSubscribe は非同期で、失敗時の live.delete は await 後の .catch で走る。
    // 同期 for-of 中に live は変化しないためコピー不要
    for (const [id, sub] of live) {
      void sendSubscribe(id, sub).catch((error: unknown) => {
        // より新しい onExit が再確立を所有していれば、この stale catch は何もしない
        if (epoch !== respawnEpoch) return;
        live.delete(id);
        logEvent("file-watcher", "resubscribe-failed", `${sub.root}: ${String(error)}`);
        sub.onError(String(error));
      });
    }
  }

  function getChild(): Promise<UtilityProcess> {
    if (ready !== undefined) return ready;
    ready = new Promise<UtilityProcess>((resolve, reject) => {
      readyReject = reject;
      const spawned = fork(scriptPath);
      spawned.on("message", onMessage);
      spawned.on("exit", onExit);
      // postMessage は spawn 完了前だと取りこぼす可能性があるため spawn を待ってから解決する
      spawned.on("spawn", () => {
        readyReject = undefined;
        resolve(spawned);
      });
      // V8 の継続不能エラー（FatalError）時に type / location / Node.js diagnostic report を得る。
      // 解放は exit 側（error を listen してもしなくても terminate 後に exit が必ず発火する保証が
      // あるため readyReject ガードが担う）に任せ、ここでは crash の中身を event-log に残す
      spawned.on("error", (type, location, report) => {
        logEvent("file-watcher", "fatal-error", `${type} @ ${location}: ${report}`);
      });
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
