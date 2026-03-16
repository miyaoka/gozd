<doc lang="md">
ghostty-web ベースのターミナルエミュレータ。
WASM パーサーで高速描画し、FitAddon の observeResize で自動リサイズする。
</doc>

<script setup lang="ts">
import { init, Terminal, FitAddon } from "ghostty-web";
import { onMounted, onBeforeUnmount, ref } from "vue";
import { useRpc } from "../rpc/useRpc";
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_THEME } from "./terminalConfig";
import { useTerminalStore } from "./useTerminalStore";

const props = defineProps<{
  dir: string;
  leafId: string;
}>();

const containerRef = ref<HTMLElement>();
const { send } = useRpc();
const terminalStore = useTerminalStore();

let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let detachDisposer: (() => void) | undefined;
let unmounted = false;

onMounted(async () => {
  const container = containerRef.value;
  if (!container) return;

  // ghostty WASM パーサーの初期化
  await init();

  terminal = new Terminal({
    fontSize: TERMINAL_FONT_SIZE,
    fontFamily: TERMINAL_FONT_FAMILY,
    theme: TERMINAL_THEME,
    cursorBlink: true,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  fitAddon.fit();
  // ResizeObserver による自動リサイズ
  fitAddon.observeResize();
  terminal.focus();

  // PTY を spawn（生存中 session があれば HMR 再マウントとしてスキップ）
  await terminalStore.spawnPty(props.leafId, terminal.cols, terminal.rows);

  // spawn の await 中に unmount された場合は以降の処理をスキップ
  if (unmounted) return;

  // store の PTY セッションに接続（ring buffer replay + live attach）
  detachDisposer = terminalStore.attachTerminal(props.leafId, (data) => {
    terminal?.write(data);
  });

  terminal.onResize(({ cols, rows }) => {
    const session = terminalStore.paneRegistry[props.leafId]?.session;
    if (session !== undefined) {
      send.ptyResize({ id: session.ptyId, cols, rows });
    }
  });

  // terminal → PTY
  terminal.onData((data) => {
    const session = terminalStore.paneRegistry[props.leafId]?.session;
    if (session !== undefined) {
      send.ptyWrite({ id: session.ptyId, data });
    }
  });
});

onBeforeUnmount(() => {
  unmounted = true;
  detachDisposer?.();
  terminal?.dispose();
});
</script>

<template>
  <div ref="containerRef" class="size-full" />
</template>
