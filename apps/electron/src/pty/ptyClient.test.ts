// ptyClient の状態機械の単体テスト。utilityProcess を fake に差し替え、spawn ack / flow control
// ack / host crash 時の exit-all を純粋な状態機械として検証する（実 electron / 実 node-pty は
// 起動しない）。主眼は「host crash で配下 pty を無言で残さず、全て exited 通知する」回帰保護。

import { describe, expect, test } from "bun:test";
import type { UtilityProcess } from "electron";
import { createPtyClient } from "./ptyClient";
import type { HostToPtyMessage, PtyToHostMessage } from "./ptyProtocol";

/** 次の microtask + macrotask を流す。emit('spawn') 後の await 継続を進めるため */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakePtyProcess {
  posted: HostToPtyMessage[];
  killed: boolean;
  on(event: string, cb: (...args: unknown[]) => void): FakePtyProcess;
  emit(event: string, ...args: unknown[]): void;
  postMessage(message: HostToPtyMessage): void;
  kill(): void;
}

function createFakePtyProcess(): FakePtyProcess {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const proc: FakePtyProcess = {
    posted: [],
    killed: false,
    on(event, cb) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      return proc;
    },
    emit(event, ...args) {
      for (const cb of handlers.get(event) ?? []) cb(...args);
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
  const processes: FakePtyProcess[] = [];
  const data: [number, string][] = [];
  const exits: [number, number, number][] = [];
  const logs: [string, string, string][] = [];
  const client = createPtyClient({
    onData: (id, text) => data.push([id, text]),
    onExit: (id, exitCode, signal) => exits.push([id, exitCode, signal]),
    logEvent: (channel, label, detail) => logs.push([channel, label, detail]),
    fork: () => {
      const proc = createFakePtyProcess();
      processes.push(proc);
      return proc as unknown as UtilityProcess;
    },
  });
  return { client, processes, data, exits, logs, labels: () => logs.map(([, label]) => label) };
}

const SPAWN_PARAMS = {
  executable: "/bin/zsh",
  args: ["-i"],
  env: {},
  cwd: "/repo",
  cols: 80,
  rows: 24,
};

/** spawn 要求を出し、host の spawned ack まで進めて pid を確定させる。 */
async function establish(ctx: ReturnType<typeof setup>, id: number, pid = 4242) {
  const pidP = ctx.client.spawn(id, SPAWN_PARAMS);
  const proc = ctx.processes[ctx.processes.length - 1];
  proc.emit("spawn");
  await tick();
  proc.emit("message", { type: "spawned", id, pid } satisfies PtyToHostMessage);
  return { pid: await pidP, proc };
}

describe("ptyClient", () => {
  test("spawn は spawned ack の pid を返し、spawn message を host に送る", async () => {
    const ctx = setup();
    const { pid, proc } = await establish(ctx, 1, 4242);
    expect(pid).toBe(4242);
    const spawnMsg = proc.posted.find((m) => m.type === "spawn");
    expect(spawnMsg).toEqual({
      type: "spawn",
      id: 1,
      executable: "/bin/zsh",
      args: ["-i"],
      env: {},
      cwd: "/repo",
      cols: 80,
      rows: 24,
    });
  });

  test("data message で onData を発火し、flow control の ack を host に返す", async () => {
    const ctx = setup();
    const { proc } = await establish(ctx, 1);
    proc.emit("message", { type: "data", id: 1, text: "hello" } satisfies PtyToHostMessage);
    expect(ctx.data).toEqual([[1, "hello"]]);
    // 転送し終えた文字数を ack して pause を解かせる
    expect(proc.posted).toContainEqual({ type: "ack", id: 1, charCount: 5 });
  });

  test("exit message は signal 優先で onExit に渡る", async () => {
    const ctx = setup();
    const { proc } = await establish(ctx, 1);
    proc.emit("message", {
      type: "exit",
      id: 1,
      exitCode: 0,
      signal: 15,
    } satisfies PtyToHostMessage);
    expect(ctx.exits).toEqual([[1, 0, 15]]);
  });

  test("host crash 時、live な全 pty を exited 通知して respawn しない", async () => {
    const ctx = setup();
    await establish(ctx, 1);
    await establish(ctx, 2);
    // host が異常終了（exit code 非 0）。配下の shell は死んでいる
    ctx.processes[0].emit("exit", 1);
    // 2 端末とも signaled(9) で exited 通知される
    expect(ctx.exits).toEqual([
      [1, 0, 9],
      [2, 0, 9],
    ]);
    expect(ctx.labels()).toContain("crashed");
    // respawn しない（新しい fork は起きていない）
    expect(ctx.processes.length).toBe(1);
  });

  test("spawnError 受信で spawn が reject する", async () => {
    const ctx = setup();
    const pidP = ctx.client.spawn(1, SPAWN_PARAMS);
    const proc = ctx.processes[ctx.processes.length - 1];
    proc.emit("spawn");
    await tick();
    proc.emit("message", { type: "spawnError", id: 1, message: "boom" } satisfies PtyToHostMessage);
    // bun は非 await の .rejects も追跡して失敗を捕捉する（codebase の commandResolver.test と同作法）
    expect(pidP).rejects.toThrow("boom");
  });

  test("spawn 確定前に host が crash したら spawn が reject し、exited 通知は出ない", async () => {
    const ctx = setup();
    const pidP = ctx.client.spawn(1, SPAWN_PARAMS);
    const proc = ctx.processes[ctx.processes.length - 1];
    proc.emit("spawn");
    await tick();
    // spawned ack が来る前に host が異常終了。pending の spawn は reject される
    proc.emit("exit", 1);
    expect(pidP).rejects.toThrow();
    // 確定前なので live に入っておらず、crash の exit-all 通知も出ない
    expect(ctx.exits).toEqual([]);
    expect(ctx.labels()).not.toContain("crashed");
  });

  test("dispose は host を kill し、crash 通知を出さない", async () => {
    const ctx = setup();
    const { proc } = await establish(ctx, 1);
    ctx.client.dispose();
    expect(proc.killed).toBe(true);
    // 意図的終了なので exit イベントが来ても exited 通知しない
    proc.emit("exit", 0);
    expect(ctx.exits).toEqual([]);
    expect(ctx.labels()).not.toContain("crashed");
  });

  test("fork が同期 throw しても ready を壊さず、次の spawn で再試行できる", async () => {
    const processes: FakePtyProcess[] = [];
    let failNextFork = true;
    const client = createPtyClient({
      onData: () => {},
      onExit: () => {},
      logEvent: () => {},
      fork: () => {
        if (failNextFork) {
          failNextFork = false;
          throw new Error("fork boom");
        }
        const proc = createFakePtyProcess();
        processes.push(proc);
        return proc as unknown as UtilityProcess;
      },
    });
    // 1 回目: fork 同期失敗 → spawn は reject
    expect(client.spawn(1, SPAWN_PARAMS)).rejects.toThrow("fork boom");
    // 2 回目: fork 成功 → lazy 再起動して spawn 成功（reject 済み ready がキャッシュされていない証拠）
    const pidP = client.spawn(2, SPAWN_PARAMS);
    const proc = processes[processes.length - 1];
    proc.emit("spawn");
    await tick();
    proc.emit("message", { type: "spawned", id: 2, pid: 7777 } satisfies PtyToHostMessage);
    expect(await pidP).toBe(7777);
  });

  test("crash 後の次の spawn で host を lazy 再起動する", async () => {
    const ctx = setup();
    await establish(ctx, 1);
    ctx.processes[0].emit("exit", 1);
    // 新規 spawn で 2 個目の host が fork される
    await establish(ctx, 2, 5555);
    expect(ctx.processes.length).toBe(2);
  });
});
