// RPC ルート実装。Swift 版 handler 群の対応物。
//
// proto3 JSON ⇔ message の変換は `@gozd/proto`（ts-proto 生成物）の
// fromJSON / toJSON をそのまま使う。ワイヤ形式・push payload の形は
// Swift shell（AppRuntime.swift の pushToRenderer）と一致させる契約。

import {
  EchoRequest,
  EchoResponse,
  PtyKillRequest,
  PtyKillResponse,
  PtyResizeRequest,
  PtyResizeResponse,
  PtySpawnRequest,
  PtySpawnResponse,
  PtyWriteRequest,
  PtyWriteResponse,
} from "@gozd/proto";
import { spawn, type IPty } from "node-pty";
import type { RpcContext, RpcHandler } from "./rpcDispatcher";

const ptys = new Map<number, IPty>();
let nextPtyId = 1;

/** will-quit で全 PTY を始末する */
export function killAllPtys(): void {
  for (const pty of ptys.values()) {
    pty.kill();
  }
  ptys.clear();
}

// Swift PTYManager が注入するターミナル環境変数と同一（docs/architecture.md）。
// GOZD_PTY_ID / GOZD_SOCKET_PATH 等の gozd 固有変数は hooks 統合ステップで移植する
const TERMINAL_ENV = {
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TERM_PROGRAM: "gozd",
  FORCE_HYPERLINK: "1",
};

function buildPtyEnv(overlay: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...TERMINAL_ENV, ...overlay };
}

function handlePtySpawn(body: unknown, ctx: RpcContext): unknown {
  const req = PtySpawnRequest.fromJSON(body);
  if (req.dir === "") throw new Error("pty/spawn: dir is required");
  if (req.executable === "") throw new Error("pty/spawn: executable is required");

  const id = nextPtyId;
  nextPtyId++;

  const pty = spawn(req.executable, req.args, {
    name: "xterm-256color",
    cols: req.cols,
    rows: req.rows,
    cwd: req.dir,
    env: buildPtyEnv(req.env),
  });
  ptys.set(id, pty);

  pty.onData((text) => {
    ctx.push("ptyText", { id, text });
  });
  pty.onExit(({ exitCode, signal }) => {
    ptys.delete(id);
    // Swift PTYExitReason と同形の payload（terminal/rpc.ts の PtyExitReason 契約）
    const reason =
      signal !== undefined && signal !== 0
        ? { kind: "signaled", signal }
        : { kind: "exited", exitCode };
    ctx.push("ptyExit", { id, reason });
  });

  return PtySpawnResponse.toJSON({ ptyId: id });
}

function handlePtyWrite(body: unknown): unknown {
  const req = PtyWriteRequest.fromJSON(body);
  const pty = ptys.get(req.ptyId);
  if (pty === undefined) throw new Error(`pty/write: unknown ptyId ${req.ptyId}`);
  pty.write(Buffer.from(req.data).toString("utf8"));
  return PtyWriteResponse.toJSON({});
}

function handlePtyResize(body: unknown): unknown {
  const req = PtyResizeRequest.fromJSON(body);
  const pty = ptys.get(req.ptyId);
  if (pty === undefined) throw new Error(`pty/resize: unknown ptyId ${req.ptyId}`);
  pty.resize(req.cols, req.rows);
  return PtyResizeResponse.toJSON({});
}

function handlePtyKill(body: unknown): unknown {
  const req = PtyKillRequest.fromJSON(body);
  const pty = ptys.get(req.ptyId);
  if (pty === undefined) throw new Error(`pty/kill: unknown ptyId ${req.ptyId}`);
  pty.kill();
  ptys.delete(req.ptyId);
  return PtyKillResponse.toJSON({});
}

function handleEcho(body: unknown): unknown {
  const req = EchoRequest.fromJSON(body);
  return EchoResponse.toJSON({ text: req.text });
}

export const routes: ReadonlyMap<string, RpcHandler> = new Map<string, RpcHandler>([
  ["/echo", handleEcho],
  ["/pty/spawn", handlePtySpawn],
  ["/pty/write", handlePtyWrite],
  ["/pty/resize", handlePtyResize],
  ["/pty/kill", handlePtyKill],
]);
