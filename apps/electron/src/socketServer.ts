// Unix Domain Socket 上で NDJSON（改行区切り JSON）を受け取る軽量サーバー。
// Swift 版 `Socket/SocketServer.swift` の対応物。CLI（`gozd open` / `gozd-cli hook`）と
// nc 直送の hook コマンドがクライアント。
//
// - 1 行 = 1 メッセージ。接続クローズ時に残った不完全な行は捨てる（クライアントは
//   必ず `\n` で終端する規約）
// - 応答は種別次第。ハンドラが文字列を返した種別だけ、その 1 行を書き戻してから閉じる。
//   クライアントは書き込み直後に FIN を送る（`socket.end(line)`）ため、応答を書く側は
//   half-open を許可して受信終端後も書き込み側を開けておく（allowHalfOpen）。既定の
//   false のままだと FIN 受信で自動的に write 側も閉じ、非同期処理を終えた応答が
//   write-after-end で落ちる
// - listen 前に stale socket file を unlink する（前回異常終了の残骸で EADDRINUSE に
//   なるため）。稼働中の別インスタンスの socket を消すリスクは channel 分離
//   （dev は worktree 単位の hash 付き channel。gozdEnv.ts）で回避する

import { unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tryCatch } from "@gozd/shared";

/** 1 行を処理し、応答が要る種別なら書き戻す 1 行を返す。応答不要なら undefined。
 * 処理中の失敗はハンドラ側で観察ログに倒す契約で、この promise は reject しない。 */
export type SocketMessageHandler = (line: string) => Promise<string | undefined>;

export interface SocketServerHandle {
  close(): void;
}

export function startSocketServer(
  socketPath: string,
  onMessage: SocketMessageHandler,
): SocketServerHandle {
  tryCatch(() => unlinkSync(socketPath));

  const server: Server = createServer({ allowHalfOpen: true }, (connection) => {
    let buffer = "";
    // 処理中のメッセージ数と受信終端。両方が揃うまで接続を閉じない。閉じる判断を
    // FIN 受信だけで下すと、応答を書く前に write 側が閉じる
    let inFlight = 0;
    let clientDone = false;
    const closeIfDone = () => {
      if (clientDone && inFlight === 0) connection.end();
    };
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      // 1 chunk に複数行が乗る（CLI が連続送信する）ケースをすべて処理する
      for (; nl !== -1; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line === "") continue;
        inFlight += 1;
        void onMessage(line)
          .then((replyLine) => {
            if (replyLine === undefined) return;
            if (connection.writableEnded) {
              console.error(
                `[SocketServer] reply dropped, connection already closed: ${replyLine.slice(0, 200)}`,
              );
              return;
            }
            connection.write(`${replyLine}\n`);
          })
          .finally(() => {
            inFlight -= 1;
            closeIfDone();
          });
      }
    });
    connection.on("end", () => {
      clientDone = true;
      closeIfDone();
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
