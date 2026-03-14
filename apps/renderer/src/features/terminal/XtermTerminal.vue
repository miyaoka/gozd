<doc lang="md">
xterm.js ベースのターミナルエミュレータ。
ghostty-web の代替として、日本語入力が安定している環境で使用する。
</doc>

<script setup lang="ts">
import { tryCatch } from "@orkis/shared";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onMounted, onBeforeUnmount, ref } from "vue";
import { useRpc } from "../rpc/useRpc";
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_THEME } from "./terminalConfig";
import { createFilePathLinkProvider } from "./useFilePathLinkProvider";

const containerRef = ref<HTMLElement>();
const { request, send, onPtyData, onPtyExit } = useRpc();

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
    fontSize: TERMINAL_FONT_SIZE,
    fontFamily: TERMINAL_FONT_FAMILY,
    theme: TERMINAL_THEME,
    cursorBlink: true,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Unicode 11 幅テーブルで CJK・絵文字の幅計算を正確にする
  const unicode11Addon = new Unicode11Addon();
  terminal.loadAddon(unicode11Addon);
  terminal.unicode.activeVersion = "11";

  // URL クリックで外部ブラウザを開く
  // WebLinksAddon: テキスト中の URL パターンを自動検出
  // linkHandler: OSC 8 エスケープシーケンスによる明示リンク（例: "PR #88"）
  const openLink = (_event: MouseEvent, url: string) => {
    send.openExternal({ url });
  };
  terminal.loadAddon(new WebLinksAddon(openLink));
  terminal.options.linkHandler = {
    activate: (event, text) => openLink(event, text),
  };

  // ファイルパスをクリックでファイラー/プレビューに反映する
  terminal.registerLinkProvider(createFilePathLinkProvider(terminal));

  terminal.open(container);

  // WebGL レンダラで GPU アクセラレーション（失敗時は DOM フォールバック）
  const term = terminal;
  const webglResult = tryCatch(() => {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
    });
    term.loadAddon(webglAddon);
  });
  if (!webglResult.ok) {
    console.warn("[xterm] WebGL unavailable, using DOM renderer:", webglResult.error);
  }

  fitAddon.fit();
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

  // Shift+Enter で Esc+CR を送信する（Claude Code が改行として認識するシーケンス）
  terminal.attachCustomKeyEventHandler((ev) => {
    if (ev.type === "keydown" && ev.key === "Enter" && ev.shiftKey) {
      if (ptyId !== undefined) {
        send.ptyWrite({ id: ptyId, data: "\x1b\r" });
      }
      return false;
    }
    return true;
  });

  // xterm → PTY
  terminal.onData((data) => {
    if (ptyId !== undefined) {
      send.ptyWrite({ id: ptyId, data });
    }
  });

  // コンテナリサイズ時に xterm と PTY を同期
  // v-show=false（display:none）でサイズが 0 になった時に fit() すると
  // cols が極小値になり、再表示後もターミナルが狭いままになるため、サイズ 0 はスキップする
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
      fitAddon?.fit();
    }
  });
  resizeObserver.observe(container);

  terminal.onResize(({ cols, rows }) => {
    if (ptyId !== undefined) {
      send.ptyResize({ id: ptyId, cols, rows });
    }
  });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
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
