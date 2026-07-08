// Electron utilityProcess のエントリ。node-pty の IPty を丸ごと所有する。
//
// なぜ別プロセスか: node-pty の exit callback（native waitpid → ThreadSafeFunction）が
// アプリ終了時の env teardown と競合すると、破壊中 isolate 上で `cb.Call` が失敗し
// node-addon-api が二重 throw → SIGABRT する（今回のクラッシュ、及び高並列時の crash）。
// in-process では消せないため、IPty をこの使い捨て host に閉じ込め、crash はこのプロセス内で
// 完結させる。main は host の exit を観測して cleanly quit する（VS Code ptyHost モデル）。
//
// build.ts が `node-pty` を external にして dist/ptyHost.cjs に bundle する（.node バイナリは
// 実行時 require、node_modules から解決。watcherProcess と同じ配管）。

import { tryCatch } from "@gozd/shared";
import { spawn, type IPty } from "node-pty";
import { createFlowController, type FlowController } from "./ptyFlowControl";
import type { HostToPtyMessage, PtyToHostMessage } from "./ptyProtocol";

// utilityProcess 内でのみ parentPort が生える。それ以外での誤起動は起動元がいないので即死
const parentPort = process.parentPort;

interface PtyEntry {
  pty: IPty;
  /** host→main IPC の backpressure。onData で onSent、main の ack で onAck を回す */
  flow: FlowController;
}

const entries = new Map<number, PtyEntry>();

function post(message: PtyToHostMessage): void {
  parentPort.postMessage(message);
}

function log(label: string, detail: string): void {
  post({ type: "log", channel: "pty-host", label, detail });
}

/** ptmx master を閉じる。node-pty destroy() で socket を閉じ、tty hangup で foreground
 * process group（閉じ忘れたサーバー子プロセス）を掃除しつつ ptmx fd リークを防ぐ。
 * destroy の遅延 SIGHUP は reaped 後の recycled pid に誤爆しうるため kill を no-op 化してから
 * 呼ぶ（routes.ts の closePtyMaster と同じ知見。crash してもこの host 内で完結する）。 */
function closePtyMaster(pty: IPty): void {
  const handle = pty as unknown as { kill: (sig?: string) => void; destroy?: () => void };
  handle.kill = () => {};
  const result = tryCatch(() => handle.destroy?.());
  if (!result.ok) {
    log("close-failed", `destroy failed: ${result.error}`);
  }
}

function handleSpawn(msg: Extract<HostToPtyMessage, { type: "spawn" }>): void {
  const result = tryCatch(() =>
    spawn(msg.executable, msg.args, {
      name: "xterm-256color",
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.cwd,
      env: msg.env,
    }),
  );
  if (!result.ok) {
    post({ type: "spawnError", id: msg.id, message: String(result.error) });
    return;
  }
  const pty = result.value;
  const entry: PtyEntry = {
    pty,
    flow: createFlowController(
      () => pty.pause(),
      () => pty.resume(),
    ),
  };
  entries.set(msg.id, entry);

  pty.onData((text) => {
    post({ type: "data", id: msg.id, text });
    entry.flow.onSent(text.length);
  });
  pty.onExit(({ exitCode, signal }) => {
    // 自然終了。ptmx fd を解放し、destroy の遅延 SIGHUP を無効化する
    closePtyMaster(pty);
    entries.delete(msg.id);
    post({ type: "exit", id: msg.id, exitCode, signal: signal ?? 0 });
  });

  post({ type: "spawned", id: msg.id, pid: pty.pid });
}

/** flow control: main が転送し終えた文字数を ack する（Low 未満に落ちたら resume が走る） */
function handleAck(id: number, charCount: number): void {
  entries.get(id)?.flow.onAck(charCount);
}

/** 単一端末クローズ。kill（SIGHUP）+ ptmx close。onExit が発火して exit を post する */
function handleKill(id: number): void {
  const entry = entries.get(id);
  if (entry === undefined) return;
  entry.pty.kill();
  closePtyMaster(entry.pty);
}

function onMessage(message: HostToPtyMessage): void {
  switch (message.type) {
    case "spawn":
      handleSpawn(message);
      break;
    case "write":
      entries.get(message.id)?.pty.write(message.data);
      break;
    case "resize":
      entries.get(message.id)?.pty.resize(message.cols, message.rows);
      break;
    case "kill":
      handleKill(message.id);
      break;
    case "ack":
      handleAck(message.id, message.charCount);
      break;
  }
}

parentPort.on("message", (event) => {
  onMessage(event.data as HostToPtyMessage);
});
