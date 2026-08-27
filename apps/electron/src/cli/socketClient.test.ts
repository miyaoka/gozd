// requestClientReply のテスト。応答を返す種別だけが通る経路で、ここで決まる文言が
// そのまま実行者（エージェント）の目に入るため、失敗 4 経路の見え方を固定する。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestClientReply } from "./socketClient";

describe("requestClientReply", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  /** 受信した 1 行に対して respond の戻り値を書き返す stub（undefined なら書かずに閉じる） */
  function startStub(respond: (line: string) => string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), "gozd-reply-test-"));
    const path = join(dir, "test.sock");
    const server: Server = createServer({ allowHalfOpen: true }, (connection) => {
      let buffer = "";
      connection.setEncoding("utf8");
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const reply = respond(buffer.slice(0, nl));
        if (reply !== undefined) connection.write(`${reply}\n`);
        connection.end();
      });
    });
    server.listen(path);
    cleanups.push(() => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return path;
  }

  test("応答の 1 行を ClientReply として返す", async () => {
    const path = startStub(() => JSON.stringify({ ok: true, dir: "/wt", error: "" }));
    expect(await requestClientReply(path, { newWorktree: undefined })).toEqual({
      ok: true,
      dir: "/wt",
      error: "",
    });
  });

  test("送った ClientMessage が 1 行の JSON として届く", async () => {
    const received: string[] = [];
    const path = startStub((line) => {
      received.push(line);
      return JSON.stringify({ ok: true, dir: "", error: "" });
    });
    await requestClientReply(path, {
      newWorktree: { dir: "/repo", title: "t", prompt: "p", ghRef: undefined },
    });
    expect(received).toEqual(['{"newWorktree":{"dir":"/repo","title":"t","prompt":"p"}}']);
  });

  test("応答が無いまま閉じたら失敗にする（送れた ≠ 実行できた）", async () => {
    const path = startStub(() => undefined);
    expect(requestClientReply(path, {})).rejects.toThrow(/closed the connection without a reply/);
  });

  test("応答が JSON として壊れていたら失敗にする", async () => {
    const path = startStub(() => "{ broken");
    expect(requestClientReply(path, {})).rejects.toThrow(/undecodable JSON/);
  });

  test("応答が返らないまま期限を過ぎたら失敗にする", async () => {
    // 応答を書かず接続も閉じない stub。main が固まったときに実行者が受け取る文言
    const dir = mkdtempSync(join(tmpdir(), "gozd-reply-test-"));
    const path = join(dir, "test.sock");
    const server = createServer({ allowHalfOpen: true }, () => {});
    server.listen(path);
    cleanups.push(() => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });
    expect(requestClientReply(path, {}, 100)).rejects.toThrow(/socket reply timeout \(100ms\)/);
  });

  test("接続先が無ければ失敗にする", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gozd-reply-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(requestClientReply(join(dir, "nosuch.sock"), {})).rejects.toThrow(/ENOENT/);
  });
});
