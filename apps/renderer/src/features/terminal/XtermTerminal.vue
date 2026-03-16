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
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRpc } from "../rpc/useRpc";
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_THEME } from "./terminalConfig";
import { createFilePathLinkProvider } from "./useFilePathLinkProvider";
import { useTerminalStore } from "./useTerminalStore";

const props = defineProps<{
  /** PTY を起動する worktree ディレクトリ */
  dir: string;
  /** このターミナルが属する leaf の ID */
  leafId: string;
  /** true の間は ResizeObserver による自動 fit() を抑制する */
  fitSuspended?: boolean;
}>();

const emit = defineEmits<{
  focus: [];
  blur: [];
}>();

const containerRef = ref<HTMLElement>();
const { send } = useRpc();
const terminalStore = useTerminalStore();

let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
let detachDisposer: (() => void) | undefined;
let unmounted = false;

/** fit() の RAF デバウンス制御 */
let fitRafId = 0;
let lastFitWidth = 0;
let lastFitHeight = 0;

function scheduleFit() {
  if (props.fitSuspended || fitRafId) return;
  fitRafId = requestAnimationFrame(() => {
    fitRafId = 0;
    const el = containerRef.value;
    if (!el || !fitAddon) return;

    const width = el.clientWidth;
    const height = el.clientHeight;
    if (width <= 0 || height <= 0) return;
    if (width === lastFitWidth && height === lastFitHeight) return;

    lastFitWidth = width;
    lastFitHeight = height;
    fitAddon.fit();
  });
}

// suspend 解除時に fit を実行
watch(
  () => props.fitSuspended,
  (suspended) => {
    if (!suspended) scheduleFit();
  },
);

/** 外部から imperative に focus を呼ぶための公開メソッド */
function focus() {
  terminal?.focus();
}

defineExpose({ focus });

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

  // xterm の focus/blur イベントを親に通知（focus の責務は TerminalLeaf が持つ）
  terminal.textarea?.addEventListener("focus", () => {
    emit("focus");
  });
  terminal.textarea?.addEventListener("blur", () => {
    emit("blur");
  });

  // Shift+Enter で Esc+CR を送信する（Claude Code が改行として認識するシーケンス）
  terminal.attachCustomKeyEventHandler((ev) => {
    if (ev.type === "keydown" && ev.key === "Enter" && ev.shiftKey) {
      const session = terminalStore.paneRegistry[props.leafId]?.session;
      if (session !== undefined) {
        send.ptyWrite({ id: session.ptyId, data: "\x1b\r" });
      }
      return false;
    }
    return true;
  });

  // PTY を spawn（生存中 session があれば HMR 再マウントとしてスキップ）
  await terminalStore.spawnPty(props.leafId, terminal.cols, terminal.rows);

  // spawn の await 中に unmount された場合は以降の処理をスキップ
  if (unmounted) return;

  // store の PTY セッションに接続（ring buffer replay + live attach）
  detachDisposer = terminalStore.attachTerminal(props.leafId, (data) => {
    terminal?.write(data);
  });

  // xterm → PTY
  terminal.onData((data) => {
    const session = terminalStore.paneRegistry[props.leafId]?.session;
    if (session !== undefined) {
      send.ptyWrite({ id: session.ptyId, data });
    }
  });

  // xterm のリサイズを PTY に同期
  terminal.onResize(({ cols, rows }) => {
    const session = terminalStore.paneRegistry[props.leafId]?.session;
    if (session !== undefined) {
      send.ptyResize({ id: session.ptyId, cols, rows });
    }
  });

  // コンテナリサイズ時に xterm と PTY を同期
  // scheduleFit() で RAF デバウンス + 幅変化なしスキップ + suspend 対応
  resizeObserver = new ResizeObserver(() => {
    scheduleFit();
  });
  resizeObserver.observe(container);
});

onBeforeUnmount(() => {
  unmounted = true;
  if (fitRafId) cancelAnimationFrame(fitRafId);
  resizeObserver?.disconnect();
  detachDisposer?.();
  terminal?.dispose();
});
</script>

<template>
  <div ref="containerRef" class="size-full" />
</template>
