import { tryCatch } from "@orkis/shared";
import fs from "node:fs";
import net from "node:net";

const SOCKET_PATH = "/tmp/orkis.sock";

interface HookMessage {
  type: "hook";
  event: "running" | "done" | "needs-input";
  payload: Record<string, unknown>;
}

interface OpenMessage {
  type: "open";
  dir: string;
  file?: string;
}

type OrkisMessage = HookMessage | OpenMessage;

type MessageHandler = (message: OrkisMessage) => void;

function setupSocketServer(onMessage: MessageHandler): net.Server {
  // 前回のクラッシュ等で残ったソケットファイルを削除
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  const server = net.createServer((connection) => {
    let buffer = "";

    connection.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      // 最後の要素は未完成の行なのでバッファに残す
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() === "") continue;
        const result = tryCatch(() => JSON.parse(line) as OrkisMessage);
        if (!result.ok) {
          console.error("[socket] invalid JSON:", line);
          continue;
        }
        onMessage(result.value);
      }
    });
  });

  server.listen(SOCKET_PATH, () => {
    console.log(`[socket] listening on ${SOCKET_PATH}`);
  });

  server.on("error", (err) => {
    console.error("[socket] server error:", err);
  });

  return server;
}

function cleanupSocket(server: net.Server) {
  server.close();
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }
}

export { cleanupSocket, setupSocketServer };
export type { OrkisMessage };
