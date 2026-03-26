import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const SOCKET_PATH = process.env.GOZD_SOCKET_PATH ?? path.join(tmpdir(), "gozd-stable.sock");

interface HookMessage {
  type: "hook";
  event: "running" | "done" | "needs-input" | "tool-done" | "tool-failure" | "stop-failure";
  payload: Record<string, unknown>;
}

interface OpenMessage {
  type: "open";
  targetPath: string;
}

type GozdMessage = HookMessage | OpenMessage;

/** ソケットに接続してメッセージを送信する。接続失敗時は reject する。 */
function sendMessage(message: GozdMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH, () => {
      client.write(JSON.stringify(message) + "\n");
      client.end();
    });

    client.on("end", () => {
      resolve();
    });

    client.on("error", (err) => {
      if ("code" in err && err.code === "ENOENT") {
        reject(new Error("gozd アプリが起動していません"));
        return;
      }
      reject(err);
    });
  });
}

export { sendMessage };
