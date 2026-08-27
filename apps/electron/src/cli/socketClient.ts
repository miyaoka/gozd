// 短命接続で ClientMessage を 1 行送って終了するソケットクライアント。
// Swift 版 `GozdSocketClient.sendOverUnixSocket`（write-all + shutdown + drain）の対応物。
// `end(line)` が write + FIN（shutdown 相当）、その後 close（サーバ側 EOF）まで待つ。

import type { ClientMessage, ClientReply } from "@gozd/rpc";
import { tryCatch } from "@gozd/shared";
import { createConnection } from "node:net";

// hook はエージェント動作のたびに発火するため、サーバ無応答でぶら下がらないよう短めに切る
const SEND_TIMEOUT_MS = 3000;

// 応答待ちは `git worktree add` の完了までかかる。送りっぱなしの hook より長く取る
const REQUEST_TIMEOUT_MS = 60000;

export function sendClientMessage(socketPath: string, message: ClientMessage): Promise<void> {
  const line = `${JSON.stringify(message)}\n`;
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(SEND_TIMEOUT_MS);
    socket.on("timeout", () => {
      socket.destroy(new Error(`socket send timeout (${SEND_TIMEOUT_MS}ms): ${socketPath}`));
    });
    socket.on("error", reject);
    socket.on("close", (hadError) => {
      if (!hadError) resolve();
    });
    // 受信データは読み捨てて EOF を待つ（drain。この種別は応答を返さない）
    socket.resume();
    socket.end(line);
  });
}

/**
 * ClientMessage を 1 行送り、返ってきた ClientReply の 1 行を読む。
 *
 * 送信側は `end(line)` で write + FIN する（サーバは half-open を許可していて、受信終端後も
 * 応答を書ける）。応答が無いまま接続が閉じたら失敗として扱う — 「送れた」ことと「相手が
 * 実行できた」ことは別で、後者を確かめずに次の指示へ進めないのがこの経路の要件。
 */
export function requestClientReply(
  socketPath: string,
  message: ClientMessage,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<ClientReply> {
  const line = `${JSON.stringify(message)}\n`;
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy(new Error(`socket reply timeout (${timeoutMs}ms): ${socketPath}`));
    });
    socket.on("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl === -1 || settled) return;
      settled = true;
      const text = buffer.slice(0, nl);
      const reply = tryCatch(() => JSON.parse(text) as ClientReply);
      socket.destroy();
      if (!reply.ok) {
        reject(new Error(`gozd replied with undecodable JSON: ${text.slice(0, 200)}`));
        return;
      }
      resolve(reply.value);
    });
    socket.on("close", () => {
      if (settled) return;
      reject(new Error(`gozd closed the connection without a reply: ${socketPath}`));
    });
    socket.end(line);
  });
}
