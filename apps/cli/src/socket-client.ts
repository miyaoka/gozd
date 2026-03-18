import net from "node:net";

const SOCKET_PATH = process.env.ORKIS_SOCKET_PATH ?? "/tmp/orkis-stable.sock";

interface HookMessage {
  type: "hook";
  event: "running" | "done" | "needs-input" | "tool-done";
  payload: Record<string, unknown>;
}

interface OpenMessage {
  type: "open";
  dir: string;
  file?: string;
}

type OrkisMessage = HookMessage | OpenMessage;

/** ソケットに接続してメッセージを送信する。接続失敗時は reject する。 */
function sendMessage(message: OrkisMessage): Promise<void> {
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
        reject(new Error("orkis アプリが起動していません"));
        return;
      }
      reject(err);
    });
  });
}

export { sendMessage };
export type { HookMessage, OpenMessage, OrkisMessage };
