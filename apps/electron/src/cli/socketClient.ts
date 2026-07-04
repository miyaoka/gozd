// 短命接続で ClientMessage を 1 行送って終了するソケットクライアント。
// Swift 版 `GozdSocketClient.sendOverUnixSocket`（write-all + shutdown + drain）の対応物。
// `end(line)` が write + FIN（shutdown 相当）、その後 close（サーバ側 EOF）まで待つ。

import type { ClientMessage } from "@gozd/rpc";
import { createConnection } from "node:net";

// hook はエージェント動作のたびに発火するため、サーバ無応答でぶら下がらないよう短めに切る
const SEND_TIMEOUT_MS = 3000;

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
    // 受信データは読み捨てて EOF を待つ（drain。プロトコルは一方向で応答なし）
    socket.resume();
    socket.end(line);
  });
}
