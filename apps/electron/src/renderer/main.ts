import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { SpikeApi } from "../ipc";

declare global {
  interface Window {
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
  const api = window.gozdSpike;
  const container = document.querySelector<HTMLElement>("#terminal");
  if (container === null) throw new Error("#terminal not found");

  const terminal = new Terminal({ fontSize: 13 });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  const ptyId = await api.ptySpawn({ cols: terminal.cols, rows: terminal.rows });

  let outputBuffer = "";
  api.onPtyData((id, data) => {
    if (id !== ptyId) return;
    terminal.write(data);
    outputBuffer += data;
  });
  api.onPtyExit((id, exitCode) => {
    if (id !== ptyId) return;
    terminal.write(`\r\n[Process exited: ${exitCode}]\r\n`);
  });
  terminal.onData((data) => {
    api.ptyWrite(ptyId, data);
  });

  window.addEventListener("resize", () => {
    fitAddon.fit();
    api.ptyResize(ptyId, terminal.cols, terminal.rows);
  });

  if (!api.isTestMode) return;

  // 自動テスト: printf の出力（コマンドラインの echo back には現れない文字列）を待つ
  api.ptyWrite(ptyId, `printf '${SPIKE_MARKER.replace("-ok", "-%s")}\\n' ok\r`);
  const timer = setInterval(() => {
    if (!outputBuffer.includes(SPIKE_MARKER)) return;
    clearInterval(timer);
    setTimeout(() => {
      api.reportSpikeResult(true, "pty echo round-trip verified");
    }, SPIKE_RENDER_WAIT_MS);
  }, 100);
  setTimeout(() => {
    clearInterval(timer);
    api.reportSpikeResult(false, `timeout; tail: ${outputBuffer.slice(-200)}`);
  }, SPIKE_TIMEOUT_MS);
}

void main();
