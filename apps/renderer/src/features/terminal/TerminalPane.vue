<script setup lang="ts">
import { init, Terminal, FitAddon } from "ghostty-web";
import { onMounted, onBeforeUnmount, ref } from "vue";
import { useRpc } from "../rpc/useRpc";

const containerRef = ref<HTMLElement>();
const { request, send, onPtyData, onPtyExit } = useRpc();

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

  ptyId = await request.ptySpawn({ cols: terminal.cols, rows: terminal.rows });

  // PTY → terminal
  removeDataListener = onPtyData(({ id, data }) => {
    if (id === ptyId) {
      terminal?.write(data);
    }
  });

  removeExitListener = onPtyExit(({ id, exitCode: _exitCode }) => {
    if (id === ptyId) {
      terminal?.write("\r\n[Process exited]\r\n");
      ptyId = undefined;
    }
  });

  terminal.onResize(({ cols, rows }) => {
    if (ptyId !== undefined) {
      send.ptyResize({ id: ptyId, cols, rows });
    }
  });

  // terminal → PTY
  terminal.onData((data) => {
    if (ptyId !== undefined) {
      send.ptyWrite({ id: ptyId, data });
    }
  });
});

onBeforeUnmount(() => {
  removeDataListener?.();
  removeExitListener?.();
  if (ptyId !== undefined) {
    send.ptyKill({ id: ptyId });
  }
  terminal?.dispose();
});
</script>

<template>
  <div ref="containerRef" class="size-full" />
</template>
