// watcherClient の respawn 状態機械の単体テスト。utilityProcess を fake に差し替え、
// onMessage / onExit を純粋な状態機械として検証する（実 electron / 実 watcher は起動しない）。
// 主眼は「二重 crash でも監視が無言停止しない」generation ガードの回帰保護。

import { describe, expect, test } from "bun:test";
import type { UtilityProcess } from "electron";
import { createWatcherClient } from "./watcherClient";
import type { HostToWatcherMessage, WatcherToHostMessage } from "./watcherProtocol";

/** 次の microtask + macrotask を流す。emit('spawn') 後の await 継続を進めるため */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** utilityProcess の最小 fake。on で登録した handler を emit で発火する。 */
interface FakeWatcherProcess {
  posted: HostToWatcherMessage[];
  killed: boolean;
  on(event: string, cb: (arg: unknown) => void): FakeWatcherProcess;
  emit(event: string, arg?: unknown): void;
  postMessage(message: HostToWatcherMessage): void;
  kill(): void;
}

function createFakeWatcherProcess(): FakeWatcherProcess {
  const handlers = new Map<string, ((arg: unknown) => void)[]>();
  const proc: FakeWatcherProcess = {
    posted: [],
    killed: false,
    on(event, cb) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      return proc;
    },
    emit(event, arg) {
      for (const cb of handlers.get(event) ?? []) cb(arg);
    },
    postMessage(message) {
      proc.posted.push(message);
    },
    kill() {
      proc.killed = true;
    },
  };
  return proc;
}

function setup() {
  const processes: FakeWatcherProcess[] = [];
  const logs: [string, string, string][] = [];
  const notifies: [string, string][] = [];
  let now = 1_000_000;
  const client = createWatcherClient({
    logEvent: (channel, label, detail) => logs.push([channel, label, detail]),
    notify: (message, detail) => notifies.push([message, detail]),
    fork: () => {
      const proc = createFakeWatcherProcess();
      processes.push(proc);
      return proc as unknown as UtilityProcess;
    },
    clock: () => now,
  });
  return {
    client,
    processes,
    logs,
    notifies,
    setNow: (t: number) => {
      now = t;
    },
    labels: () => logs.map(([, label]) => label),
  };
}

/** 最後に fork された proc を spawn → subscribe ack まで進める。 */
async function ackSubscribe(proc: FakeWatcherProcess, id: number): Promise<void> {
  proc.emit("spawn");
  await tick();
  proc.emit("message", { type: "subscribed", id } satisfies WatcherToHostMessage);
  await tick();
}

/** 1 件の watch を確立し、記録用の events/errors と handle / proc を返す。 */
async function establish(ctx: ReturnType<typeof setup>, root = "/repo") {
  const events: string[][] = [];
  const errors: string[] = [];
  const handleP = ctx.client.subscribe(
    root,
    [],
    (paths) => events.push(paths),
    (message) => errors.push(message),
  );
  const proc = ctx.processes[ctx.processes.length - 1];
  proc.emit("spawn");
  await tick();
  const msg = proc.posted.find((m) => m.type === "subscribe");
  if (msg === undefined || msg.type !== "subscribe") throw new Error("no subscribe posted");
  proc.emit("message", { type: "subscribed", id: msg.id } satisfies WatcherToHostMessage);
  const handle = await handleP;
  return { handle, events, errors, id: msg.id, proc };
}

describe("watcherClient respawn state machine", () => {
  test("single crash: respawn re-establishes the watch and keeps delivering events", async () => {
    const ctx = setup();
    const { events, errors, id } = await establish(ctx);

    ctx.processes[0].emit("exit", 1); // crash → respawn forks proc2
    const proc2 = ctx.processes[1];
    await ackSubscribe(proc2, id);
    proc2.emit("message", { type: "events", id, paths: ["/a"] } satisfies WatcherToHostMessage);

    expect(events).toContainEqual(["/a"]);
    expect(errors).toEqual([]);
    expect(ctx.labels()).toContain("crashed");
  });

  test("double crash: stale resubscribe .catch does not silently drop the live watch", async () => {
    const ctx = setup();
    const { handle, events, errors, id } = await establish(ctx); // proc1

    ctx.processes[0].emit("exit", 1); // onExit#1: epoch=1, forks proc2 (awaiting spawn)
    const proc2 = ctx.processes[1];
    proc2.emit("exit", 1); // onExit#2 before proc2 spawn: rejects proc2, onExit#1's catch(epoch1) queued; epoch=2, forks proc3
    await tick(); // let the stale catch(epoch1) run — must be a no-op

    const proc3 = ctx.processes[2];
    await ackSubscribe(proc3, id);
    proc3.emit("message", { type: "events", id, paths: ["/b"] } satisfies WatcherToHostMessage);

    // live は保持され新プロセスの event が届く（stale catch が live.delete していない証拠）
    expect(events).toContainEqual(["/b"]);
    // stale catch が onError を撃っていない
    expect(errors).toEqual([]);
    // leak しない: live に id が残っているので unsubscribe が新プロセスに届く
    await handle.unsubscribe();
    expect(proc3.posted.some((m) => m.type === "unsubscribe" && m.id === id)).toBe(true);
  });

  test("crash flood within window: gives up, notifies, stops respawning", async () => {
    const ctx = setup();
    await establish(ctx); // proc1

    // 窓内で上限 (5) を超える crash。各 exit が次を fork し、超過時に respawn を止める
    for (let i = 0; i < 6; i++) {
      ctx.processes[ctx.processes.length - 1].emit("exit", 1);
    }

    expect(ctx.notifies.length).toBe(1);
    expect(ctx.notifies[0][0]).toContain("stopped");
    expect(ctx.labels()).toContain("gave-up");
    // gave-up 後は fork しない（proc1 + respawn 5 回 = 6 プロセスで打ち止め）
    expect(ctx.processes.length).toBe(6);
  });

  test("no live subscriptions: exit does not respawn", async () => {
    const ctx = setup();
    const { handle } = await establish(ctx); // proc1
    await handle.unsubscribe(); // live 空

    const before = ctx.processes.length;
    ctx.processes[0].emit("exit", 1);

    expect(ctx.processes.length).toBe(before); // 再 fork なし
    expect(ctx.labels()).not.toContain("crashed");
  });

  test("dispose: kills the process and a later exit does not respawn", async () => {
    const ctx = setup();
    const { proc } = await establish(ctx); // proc1

    ctx.client.dispose();
    expect(proc.killed).toBe(true);

    const before = ctx.processes.length;
    proc.emit("exit", 0);
    expect(ctx.processes.length).toBe(before); // dispose 後は respawn しない
  });
});
