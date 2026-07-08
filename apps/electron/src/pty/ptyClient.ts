// main 側 owner。node-pty を隔離した utilityProcess（ptyHost.cjs）を起動し、routes.ts に
// IPty 相当の proxy を提供する。main には node-pty の実体が一切残らない（import しない）ため、
// node-pty の env teardown crash を起こす isolate は使い捨ての host 側にしか存在しない。
//
// crash 復帰の設計が watcher と決定的に違う点: watcher は re-subscribe で透過復帰できるが、
// pty host が落ちると配下の shell/claude セッションは子プロセスごと死ぬため蘇生できない。
// よって host crash 時は respawn して復元せず、live な全 pty を exited として renderer に通知
// （ptyExit push）し、次の spawn 要求で host を lazy 再起動する。app 丸ごと即死よりは厳密に
// 改善（app は生存、当該端末だけ死ぬ）。VS Code も host crash 時は端末を exited 扱いにする。

import type { UtilityProcess } from "electron";
import { join } from "node:path";
import type { HostToPtyMessage, PtyToHostMessage } from "./ptyProtocol";

interface PtySpawnParams {
  executable: string;
  /** node-pty 流儀の args（argv[0] を除いた残り） */
  args: string[];
  env: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
}

export interface PtyClientDeps {
  /** onData。renderer へ転送する。転送後に client が flow control の ack を host へ返す */
  onData: (id: number, text: string) => void;
  /** onExit（自然終了 / kill / host crash 経由）。renderer へ ptyExit を push する */
  onExit: (id: number, exitCode: number, signal: number) => void;
  /** 診断イベント（crash / host 内部ログ）を event-log パネルへ流す */
  logEvent: (channel: string, label: string, detail: string) => void;
  /** test 用 seam。省略時は electron の utilityProcess.fork（遅延 require） */
  fork?: (scriptPath: string) => UtilityProcess;
}

export interface PtyClient {
  /** id は routes.ts が採番する ptyId。戻り値は shell の pid（portScanner の帰属に使う） */
  spawn(id: number, params: PtySpawnParams): Promise<number>;
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  /** 単一端末クローズ（SIGHUP + ptmx close）。exit は host の onExit 経由で届く */
  kill(id: number): void;
  /** app 終了時に host を停止する（意図的終了。crash 通知しない） */
  dispose(): void;
}

export function createPtyClient(deps: PtyClientDeps): PtyClient {
  const { onData, onExit, logEvent } = deps;
  // 遅延 require で electron の値 import を実行時まで先送りする（watcherClient と同じ理由）
  const fork =
    deps.fork ??
    ((path: string) =>
      (require("electron") as typeof import("electron")).utilityProcess.fork(path, [], {
        serviceName: "gozd-pty-host",
      }));
  // dev / packaged いずれも __dirname は dist を指す（build.ts が dist/ptyHost.cjs に出力）
  const scriptPath = join(__dirname, "ptyHost.cjs");

  let child: UtilityProcess | undefined;
  let ready: Promise<UtilityProcess> | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  let disposing = false;

  // 生存中の pty id 集合。host crash 時にまとめて exited 通知する対象
  const live = new Set<number>();
  // spawn ack 待ち。spawned / spawnError を id で相関する
  const pending = new Map<number, { resolve: (pid: number) => void; reject: (error: Error) => void }>();

  function onHostMessage(message: PtyToHostMessage): void {
    switch (message.type) {
      case "spawned":
        pending.get(message.id)?.resolve(message.pid);
        pending.delete(message.id);
        break;
      case "spawnError":
        pending.get(message.id)?.reject(new Error(message.message));
        pending.delete(message.id);
        break;
      case "data":
        onData(message.id, message.text);
        // flow control: 転送し終えたので host に ack を返し pause を解かせる
        child?.postMessage({
          type: "ack",
          id: message.id,
          charCount: message.text.length,
        } satisfies HostToPtyMessage);
        break;
      case "exit":
        live.delete(message.id);
        onExit(message.id, message.exitCode, message.signal);
        break;
      case "log":
        logEvent(message.channel, message.label, message.detail);
        break;
    }
  }

  function onExitHost(code: number): void {
    child = undefined;
    ready = undefined;
    const rejectSpawn = readyReject;
    readyReject = undefined;
    rejectSpawn?.(new Error(`pty host exited before spawn (code=${code})`));
    // in-flight の spawn を reject して awaiter を解放する
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`pty host exited (code=${code})`));
    }
    pending.clear();

    if (disposing || live.size === 0) return;

    // host crash: 配下の shell は死んでいる。respawn しても復元できないため、live な全 pty を
    // exited として renderer に通知し状態を掃除する。次の spawn で host を lazy 再起動する。
    logEvent("pty-host", "crashed", `process exited (code=${code}); ${live.size} terminals down`);
    for (const id of live) {
      // signal 経由の異常終了として扱う（SIGKILL 相当）。renderer は ptyExit を signaled で描く
      onExit(id, 0, 9);
    }
    live.clear();
  }

  function getChild(): Promise<UtilityProcess> {
    if (ready !== undefined) return ready;
    ready = new Promise<UtilityProcess>((resolve, reject) => {
      readyReject = reject;
      const spawned = fork(scriptPath);
      // main 側の utilityProcess message は payload を直に受け取る（child の parentPort とは
      // 非対称。child は event.data でラップされる）。watcherClient と同じ扱い
      spawned.on("message", (message: PtyToHostMessage) => {
        onHostMessage(message);
      });
      spawned.on("exit", onExitHost);
      spawned.on("spawn", () => {
        readyReject = undefined;
        resolve(spawned);
      });
      spawned.on("error", (type, location, report) => {
        logEvent("pty-host", "fatal-error", `${type} @ ${location}: ${report}`);
      });
      child = spawned;
    });
    return ready;
  }

  async function spawn(id: number, params: PtySpawnParams): Promise<number> {
    const proc = await getChild();
    const ack = new Promise<number>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    proc.postMessage({
      type: "spawn",
      id,
      executable: params.executable,
      args: params.args,
      env: params.env,
      cwd: params.cwd,
      cols: params.cols,
      rows: params.rows,
    } satisfies HostToPtyMessage);
    const pid = await ack;
    live.add(id);
    return pid;
  }

  function write(id: number, data: string): void {
    child?.postMessage({ type: "write", id, data } satisfies HostToPtyMessage);
  }

  function resize(id: number, cols: number, rows: number): void {
    child?.postMessage({ type: "resize", id, cols, rows } satisfies HostToPtyMessage);
  }

  function kill(id: number): void {
    child?.postMessage({ type: "kill", id } satisfies HostToPtyMessage);
  }

  function dispose(): void {
    disposing = true;
    live.clear();
    const proc = child;
    child = undefined;
    ready = undefined;
    // host を terminate する。host の env teardown（pending TSFN の drain crash 含む）は
    // この使い捨てプロセス内で完結し、main は cleanly quit する
    proc?.kill();
  }

  return { spawn, write, resize, kill, dispose };
}
