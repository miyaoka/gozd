// spike ページ。実 renderer と同じワイヤ（__gozdElectronRpc + structured clone）で
// /pty/spawn 〜 echo round-trip を検証する自動テストハーネス。
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { ElectronRpcBridge } from "@gozd/shared";
import type { SpikeApi } from "../ipc";

declare global {
  interface Window {
    __gozdElectronRpc: ElectronRpcBridge;
    gozdSpike: SpikeApi;
  }
}

const SPIKE_MARKER = "gozd-spike-ok";
const SPIKE_TIMEOUT_MS = 15000;
/** マーカー検出後、描画反映を待ってからスクリーンショットさせる余裕 */
const SPIKE_RENDER_WAIT_MS = 500;

// spike 自動テスト: renderer 側の例外も main へ報告して観測可能にする
window.addEventListener("error", (event) => {
  window.gozdSpike?.reportSpikeResult(false, `renderer error: ${event.message}`);
});
window.addEventListener("unhandledrejection", (event) => {
  window.gozdSpike?.reportSpikeResult(false, `renderer rejection: ${String(event.reason)}`);
});

async function main() {
  const rpc = window.__gozdElectronRpc;
  const container = document.querySelector<HTMLElement>("#terminal");
  if (container === null) throw new Error("#terminal not found");

  const terminal = new Terminal({ fontSize: 13 });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  // PtySpawnRequest。dir はテスト用に "/"（spike ページは homedir を知らない）
  const spawnRes = await rpc.request("/pty/spawn", {
    dir: "/",
    executable: "/bin/zsh",
    // args はワイヤ契約 (Swift execve 流儀) どおり argv[0] を含む argv 全体
    args: ["/bin/zsh", "-l"],
    env: {},
    rows: terminal.rows,
    cols: terminal.cols,
    worktreePath: "",
  });
  const ptyId: number = (spawnRes as { ptyId: number }).ptyId;

  let outputBuffer = "";
  rpc.onPush((type, payload) => {
    if (type === "ptyText") {
      const { id, text } = payload as { id: number; text: string };
      if (id !== ptyId) return;
      terminal.write(text);
      outputBuffer += text;
      return;
    }
    if (type === "ptyExit") {
      const { id } = payload as { id: number };
      if (id !== ptyId) return;
      terminal.write("\r\n[Process exited]\r\n");
    }
  });

  // PtyWriteRequest.data はテキスト直送（旧ワイヤの base64 bytes は proto 廃止時に置き換えた）
  const writePty = (data: string) => {
    void rpc.request("/pty/write", { ptyId, data });
  };
  terminal.onData(writePty);

  window.addEventListener("resize", () => {
    fitAddon.fit();
    void rpc.request("/pty/resize", { ptyId, rows: terminal.rows, cols: terminal.cols });
  });

  if (!window.gozdSpike.isTestMode) return;

  // 自動テスト: printf の出力（コマンドラインの echo back には現れない文字列）を待つ
  writePty(`printf '${SPIKE_MARKER.replace("-ok", "-%s")}\\n' ok\r`);
  const timer = setInterval(() => {
    if (!outputBuffer.includes(SPIKE_MARKER)) return;
    clearInterval(timer);
    setTimeout(() => {
      window.gozdSpike.reportSpikeResult(true, "pty echo round-trip verified via rpc bridge");
    }, SPIKE_RENDER_WAIT_MS);
  }, 100);
  setTimeout(() => {
    clearInterval(timer);
    window.gozdSpike.reportSpikeResult(false, `timeout; tail: ${outputBuffer.slice(-200)}`);
  }, SPIKE_TIMEOUT_MS);
}

void main();
