<script setup lang="ts">
import { init, Terminal, FitAddon } from "ghostty-web";
import { onMounted, onBeforeUnmount, ref } from "vue";

const containerRef = ref<HTMLElement>();

let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let ptyId: number | undefined;
let removeDataListener: (() => void) | undefined;
let removeExitListener: (() => void) | undefined;

onMounted(async () => {
  const container = containerRef.value;
  if (!container) return;

  // ghostty WASM パーサーの初期化
  await init();

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

  fitAddon.fit();
  // ResizeObserver による自動リサイズ
  fitAddon.observeResize();
  terminal.focus();

  ptyId = await window.api.pty.spawn(terminal.cols, terminal.rows);

  // PTY → terminal
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

  // terminal → PTY
  terminal.onData((data) => {
    if (ptyId !== undefined) {
      window.api.pty.write(ptyId, data);
    }
  });

  terminal.onResize(({ cols, rows }) => {
    if (ptyId !== undefined) {
      window.api.pty.resize(ptyId, cols, rows);
    }
  });
});

onBeforeUnmount(() => {
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
