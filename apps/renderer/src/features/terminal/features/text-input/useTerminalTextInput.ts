/**
 * 端末 1 つ分の文字入力面。EditContext を付けた要素（host）が端末の焦点を持ち、キー入力と IME を
 * 受け、変換中の文字列を文節の下線つきでカーソル位置に描く。
 *
 * 文節の範囲と太さをページが受け取れる経路は EditContext の textformatupdate だけで、
 * EditContext は textarea に付けられない。xterm の textarea は焦点状態を xterm に伝えるためだけに
 * 残す（xtermInputPort.ts）。
 *
 * ## 変換中の表示は同期で描く
 *
 * EditContext を付けた要素の中身はブラウザが描かないので、変換中の文字列を自分で描く。
 * IME は textupdate の直後に文字の矩形を問い合わせる（characterboundsupdate）ため、描画を
 * 非同期に遅らせると古い矩形を答えることになる。イベントの中で DOM を直接書き換える。
 *
 * ## 貼り付けとコピーは xterm に任せる
 *
 * host は xterm の要素の子孫に置くので、paste / copy は xterm が要素に付けた listener へ
 * bubble する。EditContext は貼り付けた文字を自分では入れないので、host は何もしない。
 *
 * ## host を隠してはいけない
 *
 * `display: none` / `visibility: hidden` にすると焦点を持てなくなる。変換中でないときは
 * 中身を空にし、背景を透明にするだけにする。
 *
 * 変換中は host に `IME_COMPOSING_ATTRIBUTE` を付ける。変換中の keydown は `isComposing` を
 * 持たないことがあり、キーバインドはこの属性で変換中を知る（shared/command の isIMEActive）。
 */
import { useEventListener } from "@vueuse/core";
import type { Terminal } from "@xterm/xterm";
import { onScopeDispose } from "vue";
import { IME_COMPOSING_ATTRIBUTE } from "../../../../shared/command";
import { routeKeyDown } from "./routeKeyDown";
import {
  INITIAL_TEXT_INPUT_STATE,
  reduceTextInput,
  toPreeditRuns,
  type PreeditUnderline,
  type TextInputEffect,
  type TextInputEvent,
} from "./textInputState";
import { createXtermInputPort } from "./xtermInputPort";

/** Blink が入力欄の変換中の下線に使う太さ（styleable_marker_painter.cc） */
const UNDERLINE_THICKNESS_PX: Record<PreeditUnderline["thickness"], number> = {
  thin: 1,
  thick: 2,
};

export type TerminalTextInputOptions = {
  onFocus: () => void;
  onBlur: () => void;
};

/**
 * open 済みの terminal に入力面を付ける。effect scope の中（component の setup か、同期実行中の
 * lifecycle hook）で呼ぶ。scope の破棄で外れる。
 */
export function useTerminalTextInput(terminal: Terminal, options: TerminalTextInputOptions): void {
  const port = createXtermInputPort(terminal);
  const doc = port.mountPoint.ownerDocument;

  const host = doc.createElement("div");
  host.className = "_terminal-text-input";
  host.setAttribute("role", "textbox");
  // 名前は xterm が textarea に付けたもの（promptLabel）を引き継ぐ。textarea は inert にして
  // アクセシビリティツリーから外す（xtermInputPort.ts）
  host.setAttribute("aria-label", terminal.textarea?.getAttribute("aria-label") ?? "");
  Object.assign(host.style, {
    position: "absolute",
    zIndex: "1",
    whiteSpace: "pre",
    pointerEvents: "none",
    outline: "none",
  });
  port.mountPoint.append(host);

  const ec = new EditContext();
  host.editContext = ec;
  const restoreFocus = port.redirectFocusTo(host);

  let state = INITIAL_TEXT_INPUT_STATE;

  function renderPreedit() {
    const theme = terminal.options.theme;
    host.style.color = theme?.foreground ?? "";
    host.style.background = state.composing ? (theme?.background ?? "") : "transparent";
    host.style.fontFamily = terminal.options.fontFamily ?? "";
    host.style.fontSize = `${terminal.options.fontSize}px`;
    host.toggleAttribute(IME_COMPOSING_ATTRIBUTE, state.composing);
    host.replaceChildren(
      ...toPreeditRuns(state.preedit, state.formats).map((run) => {
        const span = doc.createElement("span");
        span.textContent = run.text;
        if (run.underline !== undefined) {
          span.style.textDecorationLine = "underline";
          span.style.textDecorationStyle = run.underline.style;
          span.style.textDecorationThickness = `${UNDERLINE_THICKNESS_PX[run.underline.thickness]}px`;
          // 既定の auto はカンマなど下線に掛かるグリフの周りで線を抜き、文節の範囲が途切れて見える。
          // Blink が入力欄に描く変換中の下線も抜かない
          span.style.textDecorationSkipInk = "none";
        }
        return span;
      }),
    );
  }

  /** host をカーソルセルに置き、IME の候補ウィンドウの基準を渡す */
  function syncBounds() {
    const cell = port.cursorCell();
    if (cell === undefined) return;
    host.style.left = `${cell.left}px`;
    host.style.top = `${cell.top}px`;
    host.style.height = `${cell.height}px`;
    host.style.lineHeight = `${cell.height}px`;
    host.style.minWidth = `${cell.width}px`;
    const rect = host.getBoundingClientRect();
    ec.updateControlBounds(rect);
    ec.updateSelectionBounds(new DOMRect(rect.right, rect.top, 0, rect.height));
  }

  function applyEffect(effect: TextInputEffect) {
    if (effect.kind === "send") {
      terminal.input(effect.data, true);
      return;
    }
    ec.updateText(0, ec.text.length, "");
    ec.updateSelection(0, 0);
  }

  function step(event: TextInputEvent) {
    const next = reduceTextInput(state, event);
    state = next.state;
    for (const effect of next.effects) applyEffect(effect);
    renderPreedit();
  }

  /** 描いた span の text node から、preedit 上の位置 index の文字矩形を測る */
  function measureCharRect(index: number): DOMRect | undefined {
    let offset = 0;
    for (const span of host.children) {
      const node = span.firstChild;
      const length = node?.textContent?.length ?? 0;
      if (node !== null && index < offset + length) {
        const range = doc.createRange();
        range.setStart(node, index - offset);
        range.setEnd(node, index - offset + 1);
        return range.getBoundingClientRect();
      }
      offset += length;
    }
    return undefined;
  }

  useEventListener(ec, "compositionstart", () => {
    // 変換を始めたら、xterm が入力時に行うのと同じく最下部へ戻す
    if (terminal.options.scrollOnUserInput !== false) terminal.scrollToBottom();
    step({ type: "compositionstart" });
    syncBounds();
  });
  useEventListener(ec, "textupdate", () => step({ type: "textupdate", bufferText: ec.text }));
  useEventListener(ec, "textformatupdate", (e: TextFormatUpdateEvent) =>
    step({ type: "textformatupdate", formats: e.getTextFormats() }),
  );
  useEventListener(ec, "compositionend", () =>
    step({ type: "compositionend", bufferText: ec.text }),
  );
  useEventListener(ec, "characterboundsupdate", (e: CharacterBoundsUpdateEvent) => {
    const rects: DOMRect[] = [];
    for (let i = e.rangeStart; i < e.rangeEnd; i++) {
      const rect = measureCharRect(i);
      if (rect === undefined) break;
      rects.push(rect);
    }
    ec.updateCharacterBounds(e.rangeStart, rects);
  });

  useEventListener(host, "keydown", (e: KeyboardEvent) => {
    if (routeKeyDown(e, state.composing) === "ime-only") return;
    port.offerKeyDown(e);
  });
  useEventListener(host, "keyup", (e: KeyboardEvent) => port.forwardKeyUp(e));
  useEventListener(host, "focus", () => {
    port.mirrorFocus(true);
    syncBounds();
    options.onFocus();
  });
  useEventListener(host, "blur", () => {
    port.mirrorFocus(false);
    options.onBlur();
  });

  // 変換中に出力でカーソルが動いたら表示位置を追う
  const renderSub = terminal.onRender(() => {
    if (state.composing) syncBounds();
  });

  renderPreedit();

  onScopeDispose(() => {
    renderSub.dispose();
    if (doc.activeElement === host) port.mirrorFocus(false);
    restoreFocus();
    host.editContext = null;
    host.remove();
  });
}
