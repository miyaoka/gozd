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

/**
 * ソケットにメッセージを送信して切断する。
 * アプリが起動していない場合はエラーを stderr に出力する。
 */
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
