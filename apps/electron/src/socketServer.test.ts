// SocketServer の統合テスト。Swift 版 `SocketServerTests.swift` のケースを対で移植し、
// NDJSON 分割（1 行 = 1 メッセージ / 複数行 / 並行接続）の契約を実ソケットで固定する。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startSocketServer,
  type SocketMessageHandler,
  type SocketServerHandle,
} from "./socketServer";

/** 受信行を記録するだけの、応答を返さないハンドラ */
function recorder(received: string[]): SocketMessageHandler {
  return (line) => {
    received.push(line);
    return Promise.resolve(undefined);
  };
}

/** 1 行送って、返ってきた最初の 1 行を返す（応答が無いまま閉じたら空文字） */
function sendAndReadReply(socketPath: string, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const client = connect(socketPath, () => {
      client.end(data);
    });
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      buffer += chunk;
    });
    client.on("error", reject);
    client.on("close", () => resolve(buffer.split("\n")[0] ?? ""));
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timeout"));
      }
    }, 10);
  });
}

function sendLines(socketPath: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(data, () => resolve());
    });
    client.on("error", reject);
  });
}

describe("SocketServer", () => {
  const cleanups: Array<() => void> = [];
  const tempDirs: string[] = [];

  function makeServer(onMessage: SocketMessageHandler): {
    handle: SocketServerHandle;
    path: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "gozd-socket-test-"));
    tempDirs.push(dir);
    const path = join(dir, "test.sock");
    const handle = startSocketServer(path, onMessage);
    cleanups.push(() => handle.close());
    return { handle, path };
  }

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("単一の NDJSON 行を受信できる", async () => {
    const received: string[] = [];
    const { path } = makeServer(recorder(received));
    await sendLines(path, '{"hook":{"event":"running","ptyId":1}}\n');
    await waitFor(() => received.length === 1);
    expect(received[0]).toBe('{"hook":{"event":"running","ptyId":1}}');
  });

  test("1 接続で複数行を順序通りに受信する", async () => {
    const received: string[] = [];
    const { path } = makeServer(recorder(received));
    await sendLines(path, '{"n":1}\n{"n":2}\n{"n":3}\n');
    await waitFor(() => received.length === 3);
    expect(received).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  test("複数接続から並行受信できる", async () => {
    const received: string[] = [];
    const { path } = makeServer(recorder(received));
    await Promise.all([
      sendLines(path, '{"from":"a"}\n'),
      sendLines(path, '{"from":"b"}\n'),
      sendLines(path, '{"from":"c"}\n'),
    ]);
    await waitFor(() => received.length === 3);
    expect(received.toSorted()).toEqual(['{"from":"a"}', '{"from":"b"}', '{"from":"c"}']);
  });

  test("応答を返すハンドラの 1 行が同じ接続に書き戻される", async () => {
    const { path } = makeServer(async (line) => `reply:${line}`);
    const reply = await sendAndReadReply(path, '{"newWorktree":{"dir":"/tmp"}}\n');
    expect(reply).toBe('reply:{"newWorktree":{"dir":"/tmp"}}');
  });

  test("応答が非同期に返っても write-after-end で落ちない", async () => {
    // クライアントは送信直後に FIN を送る。allowHalfOpen が無いと、この待ち時間の間に
    // write 側まで閉じられて応答が書けなくなる
    const { path } = makeServer(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return '{"ok":true}';
    });
    const reply = await sendAndReadReply(path, '{"newWorktree":{"dir":"/tmp"}}\n');
    expect(reply).toBe('{"ok":true}');
  });

  test("応答不要のハンドラでは接続が閉じるだけで何も書き戻さない", async () => {
    const received: string[] = [];
    const { path } = makeServer(recorder(received));
    const reply = await sendAndReadReply(path, '{"hook":{"event":"running","ptyId":1}}\n');
    expect(reply).toBe("");
    expect(received).toEqual(['{"hook":{"event":"running","ptyId":1}}']);
  });

  test("接続クローズ時に残った不完全な行は捨てる（\\n 終端規約）", async () => {
    const received: string[] = [];
    const { path } = makeServer(recorder(received));
    await sendLines(path, '{"complete":true}\n{"incomplete":');
    await waitFor(() => received.length === 1);
    // 少し待っても不完全な行は届かない
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual(['{"complete":true}']);
  });
});
