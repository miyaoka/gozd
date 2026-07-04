// Unix Domain Socket 上で NDJSON（改行区切り JSON）を受け取る軽量サーバー。
// Swift 版 `Socket/SocketServer.swift` の対応物。CLI（`gozd open` / `gozd-cli hook`）と
// nc 直送の hook コマンドがクライアント。
//
// - 1 行 = 1 メッセージ。接続クローズ時に残った不完全な行は捨てる（クライアントは
//   必ず `\n` で終端する規約）
// - listen 前に stale socket file を unlink する（前回異常終了の残骸で EADDRINUSE に
//   なるため）。稼働中の別インスタンスの socket を消すリスクは channel 分離で回避する

import { unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tryCatch } from "@gozd/shared";

export type SocketMessageHandler = (line: string) => void;

export interface SocketServerHandle {
  close(): void;
}

export function startSocketServer(socketPath: string, onMessage: SocketMessageHandler): SocketServerHandle {
  tryCatch(() => unlinkSync(socketPath));

  const server: Server = createServer((connection) => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      // 1 chunk に複数行が乗る（CLI が連続送信する）ケースをすべて処理する
      for (; nl !== -1; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line !== "") onMessage(line);
      }
    });
    connection.on("error", (error) => {
      // クライアント切断系（EPIPE / ECONNRESET）は正常系。それ以外は観察ログを残す
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPIPE" && code !== "ECONNRESET") {
        console.error(`[SocketServer] connection error: ${error}`);
      }
    });
  });

  server.on("error", (error) => {
    console.error(`[SocketServer] server error: ${error}`);
  });
  server.listen(socketPath);

  return {
    close() {
      server.close();
      tryCatch(() => unlinkSync(socketPath));
    },
  };
}
