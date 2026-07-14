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
import { createCwdTracker } from "./cwdTracker";
import { parseOsc7Cwd } from "./parseOsc7Cwd";
import { rpcOpenExternal, rpcPtyResize, rpcPtyWrite } from "./rpc";
import {
  currentTheme,
  terminalFontFamily,
  terminalFontSize,
  terminalScrollback,
} from "./terminalConfig";
import { createFilePathLinkProvider } from "./useFilePathLinkProvider";
import { useTerminalStore } from "./useTerminalStore";

/**
 * xterm の現在の可視画面（スクロール位置に依らず最新の 1 画面分）をテキスト化する。
 * Claude の承認 UI 文言（asking 離脱検知）を画面本文から拾うために使う。baseY 起点で
 * `rows` 行読むので、ユーザーが scrollback を遡っていても最新画面を見る。
 */
function extractVisibleText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.baseY + i);
    if (line !== undefined) lines.push(line.translateToString(true));
  }
  return lines.join("\n");
}

const props = defineProps<{
  /** PTY を起動する worktree ディレクトリ */
  dir: string;
  /** このターミナルが属する leaf の ID */
  leafId: string;
  /** true の間は ResizeObserver による自動 fit() を抑制する */
  fitSuspended?: boolean;
  /** true になったタイミングで imperative に DOM focus を当てる */
  focused?: boolean;
  /** leaf が表示中か（v-show と同値）。WebglAddon のライフサイクルを同期する */
  visible: boolean;
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
let webglAddon: WebglAddon | undefined;
let webglReloadedAfterLoss = false;

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

/**
 * WebGL context はページ全体で同時保持数に上限があり（Chromium は 16。17 個目の作成で
 * 最古が強制 evict される）、gozd は全 worktree の全 leaf を mount し続けるため、全 leaf に
 * context を持たせると上限に飽和する。飽和状態では「作り直し」が別の端末を evict する
 * 玉突きになり永久に収束しない。可視 leaf だけが context を持つことで総数を上限未満に保つ。
 *
 * evict された非表示 canvas は再描画されない限り webglcontextrestored が発火せず、addon 内部の
 * 復帰待ち失敗後の onContextLoss で通知される。復帰手段は addon の作り直しだけなので、
 * lost したら dispose し、次の可視化で作り直す。
 */
function loadWebglAddon() {
  const term = terminal;
  if (term === undefined || webglAddon !== undefined) return;
  const addon = new WebglAddon();
  addon.onContextLoss(() => {
    console.warn(`[XtermTerminal] WebGL context lost leafId=${props.leafId}`);
    disposeWebglAddon();
    // 可視中の lost（GPU プロセス再起動等）は hide/show を待たず 1 回だけ自己復帰を試みる。
    // 1 回で打ち切るのは、可視 leaf が上限 16 を超える飽和状態では再ロードが別の可視 leaf を
    // evict する玉突きになるため（1 回制限により連鎖は leaf 数で有限に止まる）
    if (!props.visible || webglReloadedAfterLoss) return;
    webglReloadedAfterLoss = true;
    requestAnimationFrame(() => {
      if (unmounted || !props.visible) return;
      loadWebglAddon();
    });
  });
  const result = tryCatch(() => term.loadAddon(addon));
  if (!result.ok) {
    console.warn(
      `[XtermTerminal] WebGL unavailable, using DOM renderer: ${result.error} leafId=${props.leafId}`,
    );
    tryCatch(() => addon.dispose());
    return;
  }
  webglAddon = addon;
}

function disposeWebglAddon() {
  if (webglAddon === undefined) return;
  const addon = webglAddon;
  webglAddon = undefined;
  // context lost 直後の dispose は内部リソースの解放に失敗しうる
  const result = tryCatch(() => addon.dispose());
  if (!result.ok) {
    console.warn(
      `[XtermTerminal] WebglAddon dispose failed: ${result.error} leafId=${props.leafId}`,
    );
  }
}

// renderer の差し替え（dispose / load）は常に可視状態で行う。
// hide は pre flush（display:none 適用前 = まだ可視のうち）に dispose し、
// show は post flush（適用後 = 寸法確定後）に load する二段構え。
watch(
  () => props.visible,
  (visible) => {
    if (visible) return;
    disposeWebglAddon();
  },
  { flush: "pre" },
);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    webglReloadedAfterLoss = false;
    loadWebglAddon();
    // 差し替え直後の cols/rows 再同期。生の fit() は scheduleFit の 0 サイズガードと
    // lastFit 記録を迂回して極小 resize 事故を起こすため使わない。hide 前と同寸だと
    // dedup に skip されるので、明示リセットで再 fit を強制する
    lastFitWidth = 0;
    lastFitHeight = 0;
    scheduleFit();
  },
  { flush: "post" },
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

  // zsh の chpwd hook（_gozd_osc7_cwd）が送る OSC 7 からシェルの cwd 遷移を
  // バッファ行位置つきで追跡する。相対パスリンクの解決基準（useFilePathLinkProvider）に使う
  const cwdTracker = createCwdTracker(terminal);
  terminal.parser.registerOscHandler(7, (data) => {
    const cwd = parseOsc7Cwd(data);
    if (cwd !== undefined) {
      cwdTracker.observe(cwd);
    }
    return true;
  });

  // ファイルパスをクリックでファイラー/プレビューに反映する
  terminal.registerLinkProvider(createFilePathLinkProvider(terminal, cwdTracker));

  // xterm.js の onTitleChange でタイトル変更を受け取り store に保存する
  // xterm.js 内部で OSC 0/2 を処理済みなので registerOscHandler ではなくイベントを購読する
  terminal.onTitleChange((title) => {
    terminalStore.setTitle(props.leafId, title);
  });

  terminal.open(container);

  // theme / font watcher のクロージャ用に非 undefined の terminal を capture する
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

  // WebGL レンダラで GPU アクセラレーション（可視 leaf のみ。理由は loadWebglAddon）
  if (props.visible) {
    loadWebglAddon();
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
    // asking の離脱（承認 UI 消失 = キャンセル / 中断）を可視画面から検知する。
    // screen text は asking のときだけ読まれる（遅延取得の関数を asking 以外では呼ばない）
    terminalStore.observeScreen(props.leafId, () => extractVisibleText(term));
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
