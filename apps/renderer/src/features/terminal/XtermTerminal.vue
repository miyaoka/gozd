<doc lang="md">
xterm.js ベースのターミナルエミュレータ。
</doc>

<script setup lang="ts">
import { tryCatch } from "@gozd/shared";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type IMarker } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { nextTick, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { rpcOpenExternal, rpcPtyResize, rpcPtyWrite } from "./rpc";
import {
  currentTheme,
  terminalFontFamily,
  terminalFontSize,
  terminalScrollback,
} from "./terminalConfig";
import { createFilePathLinkProvider } from "./useFilePathLinkProvider";
import { useTerminalStore } from "./useTerminalStore";

const props = defineProps<{
  /** PTY を起動する worktree ディレクトリ */
  dir: string;
  /** このターミナルが属する leaf の ID */
  leafId: string;
  /** true の間は ResizeObserver による自動 fit() を抑制する */
  fitSuspended?: boolean;
  /** true になったタイミングで imperative に DOM focus を当てる */
  focused?: boolean;
}>();

const emit = defineEmits<{
  focus: [];
  blur: [];
}>();

const containerRef = ref<HTMLElement>();
const terminalStore = useTerminalStore();
function sendPtyWrite(ptyId: number, data: string) {
  void rpcPtyWrite({ ptyId, data });
}
function sendPtyResize(ptyId: number, cols: number, rows: number) {
  void rpcPtyResize({ ptyId, cols, rows });
}

let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let resizeObserver: ResizeObserver | undefined;
let detachDisposer: (() => void) | undefined;
let writeParsedDisposer: (() => void) | undefined;
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

    // alternate buffer（TUI アプリ）は scrollback がないため bottom にリセットする
    // primary buffer（通常シェル）は Marker で reflow に追従してスクロール位置を保持する
    const isAlternate = terminal?.buffer.active.type === "alternate";
    const buf = terminal?.buffer.active;
    const wasAtBottom = buf !== undefined && buf.viewportY >= buf.baseY;
    const marker =
      !isAlternate && !wasAtBottom && terminal !== undefined && buf !== undefined
        ? terminal.registerMarker(buf.viewportY - buf.baseY - buf.cursorY)
        : undefined;

    lastFitWidth = width;
    lastFitHeight = height;
    fitAddon.fit();

    // リサイズ後にスクロール位置を復元
    if (terminal !== undefined) {
      if (isAlternate || wasAtBottom) {
        terminal.scrollToBottom();
      } else if (marker !== undefined && !marker.isDisposed) {
        terminal.scrollToLine(Math.min(marker.line, terminal.buffer.active.baseY));
      }
      marker?.dispose();
    }
  });
}

// suspend 解除時に fit を実行
watch(
  () => props.fitSuspended,
  (suspended) => {
    if (!suspended) scheduleFit();
  },
);

// focused prop が true → false → true の遷移で imperative に DOM focus を当てる。
// 初期 focused の取りこぼしは onMounted 内で `terminal.open(container)` 完了直後に
// props.focused を見て自前で focus する。watch に immediate: true を付けると
// async onMounted 内の `terminal = new Terminal(...)` 完了との順序保証が無く、
// `nextTick` 待ちでも terminal が未初期化のまま `terminal?.focus()` が silent no-op に
// 倒れる事故源になるため避ける。
watch(
  () => props.focused,
  async (focused) => {
    if (!focused) return;
    await nextTick();
    terminal?.focus();
  },
  { flush: "post" },
);

onMounted(async () => {
  const container = containerRef.value;
  if (!container) return;

  terminal = new Terminal({
    // 空文字 / 0 は未設定 → xterm デフォルトに委ねる
    ...(terminalFontFamily.value !== "" && { fontFamily: terminalFontFamily.value }),
    ...(terminalFontSize.value > 0 && { fontSize: terminalFontSize.value }),
    scrollback: terminalScrollback,
    theme: currentTheme.value,
    cursorBlink: true,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Unicode 11 幅テーブルで CJK・絵文字の幅計算を正確にする
  const unicode11Addon = new Unicode11Addon();
  terminal.loadAddon(unicode11Addon);
  terminal.unicode.activeVersion = "11";

  // URL クリックで外部ブラウザを開く（Shift+クリックのみ）
  // WebLinksAddon: テキスト中の URL パターンを自動検出
  // linkHandler: OSC 8 エスケープシーケンスによる明示リンク（例: "PR #88"）
  const openLink = (event: MouseEvent, url: string) => {
    if (!event.shiftKey) return;
    void rpcOpenExternal({ url });
  };
  terminal.loadAddon(new WebLinksAddon(openLink));
  terminal.options.linkHandler = {
    activate: (event, text) => openLink(event, text),
  };

  // ファイルパスをクリックでファイラー/プレビューに反映する
  terminal.registerLinkProvider(createFilePathLinkProvider(terminal));

  // xterm.js の onTitleChange でタイトル変更を受け取り store に保存する
  // xterm.js 内部で OSC 0/2 を処理済みなので registerOscHandler ではなくイベントを購読する
  terminal.onTitleChange((title) => {
    terminalStore.setTitle(props.leafId, title);
  });

  terminal.open(container);

  // WebGL レンダラで GPU アクセラレーション（失敗時は DOM フォールバック）
  const term = terminal;

  // テーマ変更を全 xterm インスタンスにリアルタイム反映
  watch(currentTheme, (theme) => {
    term.options.theme = theme;
  });

  // フォント変更をリアルタイム反映（空文字 / 0 なら xterm デフォルトに戻す）
  // フォントメトリクスが変わるため fit() でセルサイズを再計算する
  watch(terminalFontFamily, (family) => {
    term.options.fontFamily = family !== "" ? family : undefined;
    fitAddon?.fit();
  });
  watch(terminalFontSize, (size) => {
    term.options.fontSize = size > 0 ? size : undefined;
    fitAddon?.fit();
  });

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

  // mount 時点で props.focused が立っていれば初回 focus を当てる。
  // 以降の false→true 遷移は上位の watch で拾うが、初期値は
  // `terminal` 初期化との順序保証が無いため watch に頼らず明示的に呼ぶ。
  if (props.focused) {
    terminal.focus();
  }

  // Shift+Enter で Esc+CR を送信する（Claude Code が改行として認識するシーケンス）
  // keydown で送信、keypress で xterm のデフォルト改行を抑止、keyup は通過させる
  terminal.attachCustomKeyEventHandler((ev) => {
    if (ev.key === "Enter" && ev.shiftKey && ev.type !== "keyup") {
      if (ev.type === "keydown") {
        const ptyId = terminalStore.getPtyId(props.leafId);
        if (ptyId !== undefined) {
          sendPtyWrite(ptyId, "\x1b\r");
        }
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
  // Marker ベースの安定アンカーで
  // スクロール位置を保持する。TUI アプリ（Claude Code 等）の再描画でエスケープシーケンスに
  // より viewportY がリセットされる場合があるため、Marker で物理行を追跡して復元する。
  // 復元処理は onWriteParsed（フレームごとに最大1回発火）で集約する
  type ViewportIntent = { kind: "bottom" } | { kind: "anchored"; marker: IMarker };
  let viewportIntent: ViewportIntent = { kind: "bottom" };
  let parsedSinceLastRestore = false;

  function disposeViewportMarker() {
    if (viewportIntent.kind === "anchored" && !viewportIntent.marker.isDisposed) {
      viewportIntent.marker.dispose();
    }
  }

  function captureViewportIntent() {
    const buf = term.buffer.active;
    if (buf.type === "alternate" || buf.viewportY >= buf.baseY) {
      disposeViewportMarker();
      viewportIntent = { kind: "bottom" };
      return;
    }
    // Marker で現在の viewport 位置をアンカーする（行の追加・削除に追従する）
    const marker = term.registerMarker(buf.viewportY - buf.baseY - buf.cursorY);
    disposeViewportMarker();
    viewportIntent = marker !== undefined ? { kind: "anchored", marker } : { kind: "bottom" };
  }

  function restoreViewportIntent() {
    const buf = term.buffer.active;
    if (buf.type === "alternate" || viewportIntent.kind === "bottom") {
      if (buf.viewportY < buf.baseY) term.scrollToBottom();
      return;
    }
    if (viewportIntent.marker.isDisposed) return;
    const targetLine = Math.min(viewportIntent.marker.line, buf.baseY);
    if (buf.viewportY !== targetLine) {
      term.scrollToLine(targetLine);
    }
  }

  const writeParsedSubscription = term.onWriteParsed(() => {
    if (!parsedSinceLastRestore) return;
    parsedSinceLastRestore = false;
    restoreViewportIntent();
  });
  writeParsedDisposer = () => writeParsedSubscription.dispose();

  detachDisposer = terminalStore.attachTerminal(props.leafId, (data) => {
    captureViewportIntent();
    // write 前にフラグを立てる。write() callback と onWriteParsed の発火順序は
    // API 仕様で担保されていないため、callback ではなくここで立てる
    parsedSinceLastRestore = true;
    term.write(data);
  });

  // xterm → PTY
  terminal.onData((data) => {
    const ptyId = terminalStore.getPtyId(props.leafId);
    if (ptyId !== undefined) {
      sendPtyWrite(ptyId, data);
    }
  });

  // xterm のリサイズを PTY に同期
  terminal.onResize(({ cols, rows }) => {
    const ptyId = terminalStore.getPtyId(props.leafId);
    if (ptyId !== undefined) {
      sendPtyResize(ptyId, cols, rows);
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
  writeParsedDisposer?.();
  detachDisposer?.();
  terminal?.dispose();
});
</script>

<template>
  <div ref="containerRef" class="size-full" />
</template>
