<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { onMounted, onBeforeUnmount, ref } from "vue";
import "@xterm/xterm/css/xterm.css";

const containerRef = ref<HTMLElement>();

let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let ptyId: number | undefined;
let removeDataListener: (() => void) | undefined;
let removeExitListener: (() => void) | undefined;
let resizeObserver: ResizeObserver | undefined;

onMounted(async () => {
  const container = containerRef.value;
  if (!container) return;

  terminal = new Terminal({
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
    theme: {
      background: "#18181b",
      foreground: "#e4e4e7",
      cursor: "#e4e4e7",
    },
    cursorBlink: true,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  // WebGL レンダラーを適用（非対応環境では canvas fallback）
  try {
    terminal.loadAddon(new WebglAddon());
  } catch {
    // WebGL 非対応の場合は標準 canvas レンダラーで描画される
  }

  fitAddon.fit();
  terminal.focus();

  ptyId = await window.api.pty.spawn(terminal.cols, terminal.rows);

  // PTY → xterm
  removeDataListener = window.api.pty.onData((id, data) => {
    if (id === ptyId) {
      terminal?.write(data);
    }
  });

  removeExitListener = window.api.pty.onExit((id, _exitCode) => {
    if (id === ptyId) {
      terminal?.write("\r\n[Process exited]\r\n");
      ptyId = undefined;
    }
  });

  // xterm → PTY
  terminal.onData((data) => {
    if (ptyId !== undefined) {
      window.api.pty.write(ptyId, data);
    }
  });

  // コンテナリサイズ時に xterm と PTY を同期
  resizeObserver = new ResizeObserver(() => {
    fitAddon?.fit();
  });
  resizeObserver.observe(container);

  terminal.onResize(({ cols, rows }) => {
    if (ptyId !== undefined) {
      window.api.pty.resize(ptyId, cols, rows);
    }
  });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  removeDataListener?.();
  removeExitListener?.();
  if (ptyId !== undefined) {
    window.api.pty.kill(ptyId);
  }
  terminal?.dispose();
});
</script>

<template>
  <div ref="containerRef" class="size-full" />
</template>
