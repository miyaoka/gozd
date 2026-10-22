/**
 * xterm.js の入力系へ繋ぐ唯一の口。xterm の非公開内部に触れるのはこのファイルだけにする。
 *
 * ## なぜ内部に触れるか
 *
 * 文節の下線を得る経路は EditContext だけで、EditContext は textarea に付けられない。焦点を持つ
 * 要素は xterm の隠し textarea ではなく、EditContext を付けた要素（host）になる。xterm は
 * keydown / keyup / focus / blur をすべて textarea で受けており、host で起きたキー入力を
 * 端末シーケンスに変える公開 API が無い。
 *
 * 実イベントを `_keyDown` に直接渡す。合成した KeyboardEvent を textarea へ dispatch する手は
 * 採らない。合成イベントは document の keydown listener（キーバインド）にもう一度届き、
 * 同じキーを二重に解決する。実イベントなら、xterm が掛ける preventDefault がそのまま host の
 * 既定動作（EditContext への文字入力）を止める。
 *
 * ## textarea の扱い
 *
 * textarea は xterm に焦点状態を伝えるためだけに残し、実際の焦点は受けない。
 *
 * - xterm の焦点状態（カーソルの描画、焦点報告 `ESC [ I` / `ESC [ O`、isFocused）は textarea の
 *   focus / blur の listener から作られる。host の焦点の変化を、合成した FocusEvent で写す
 * - xterm が焦点を取りに行く呼び出し（`terminal.focus()`、mousedown、keyup）は
 *   `textarea.focus()` に集まっている。textarea の focus / blur を host へ向け直す
 *
 * ## 失敗の扱い
 *
 * xterm の更新で内部の形が変わったら、生成時に throw する。textarea の入力に戻すことはしない。
 */
import type { Terminal } from "@xterm/xterm";

/** xterm 6.0.0 の CoreBrowserTerminal のうち、ここが触れる部分 */
type XtermCoreInternals = {
  /**
   * keydown を処理する。true は「xterm は引き受けなかった」。false は送出済みか
   * customKeyEventHandler による拒否、undefined は screenReaderMode での送出済み
   */
  _keyDown(ev: KeyboardEvent): boolean | undefined;
  /** keyup を処理する。修飾キー以外では中で `focus()` を呼ぶ */
  _keyUp(ev: KeyboardEvent): void;
  _renderService: { dimensions: { css: { cell: { width: number; height: number } } } };
};

function isXtermCoreInternals(value: unknown): value is XtermCoreInternals {
  if (typeof value !== "object" || value === null) return false;
  const core = value as Partial<Record<keyof XtermCoreInternals, unknown>>;
  const renderService = core._renderService as XtermCoreInternals["_renderService"] | undefined;
  return (
    typeof core._keyDown === "function" &&
    typeof core._keyUp === "function" &&
    typeof renderService?.dimensions?.css?.cell?.width === "number"
  );
}

/** helper container（textarea の親）を基準にした CSS px の矩形 */
type CellRect = { left: number; top: number; width: number; height: number };

export type XtermInputPort = {
  /** host を置く親。xterm の textarea と同じ helper container で、paste の bubble 先を共有する */
  mountPoint: HTMLElement;
  /**
   * 実 keydown を xterm に渡す。xterm が引き受けたキーは必ず既定動作を止める
   * （EditContext に文字を作らせない）。引き受けなかったキーは既定動作のまま残す。
   */
  offerKeyDown(ev: KeyboardEvent): void;
  forwardKeyUp(ev: KeyboardEvent): void;
  /** host の焦点の変化を xterm へ写す */
  mirrorFocus(focused: boolean): void;
  /** カーソルセルの矩形。カーソルが viewport の外なら undefined */
  cursorCell(): CellRect | undefined;
  /** xterm の焦点要求を host へ向け直す。戻り値で元に戻す */
  redirectFocusTo(host: HTMLElement): () => void;
};

export function createXtermInputPort(terminal: Terminal): XtermInputPort {
  const core: unknown = (terminal as unknown as { _core?: unknown })._core;
  if (!isXtermCoreInternals(core)) {
    throw new Error("[xtermInputPort] xterm internals changed: _keyDown / _keyUp / _renderService");
  }
  const textarea = terminal.textarea;
  const mountPoint = textarea?.parentElement;
  if (textarea === undefined || mountPoint === null || mountPoint === undefined) {
    throw new Error("[xtermInputPort] terminal is not opened");
  }

  return {
    mountPoint,
    offerKeyDown(ev) {
      const accepted = core._keyDown(ev) !== true || ev.defaultPrevented;
      // customKeyEventHandler が false を返した経路（Shift+Enter）は xterm が既定動作を止めない
      if (accepted && !ev.defaultPrevented) ev.preventDefault();
    },
    forwardKeyUp(ev) {
      core._keyUp(ev);
    },
    mirrorFocus(focused) {
      textarea.dispatchEvent(new FocusEvent(focused ? "focus" : "blur"));
    },
    cursorCell() {
      const buf = terminal.buffer.active;
      const row = buf.baseY + buf.cursorY - buf.viewportY;
      if (row < 0 || row >= terminal.rows) return undefined;
      const { width, height } = core._renderService.dimensions.css.cell;
      const col = Math.min(buf.cursorX, terminal.cols - 1);
      return { left: col * width, top: row * height, width, height };
    },
    redirectFocusTo(host) {
      // Tab・支援技術から焦点を受けず、アクセシビリティツリーにも出ないようにする。
      // スクリプトからの dispatchEvent は止めないので、mirrorFocus は働く
      textarea.inert = true;
      // インスタンスの own property で prototype の focus / blur を覆う
      textarea.focus = (options?: FocusOptions) => host.focus(options);
      textarea.blur = () => host.blur();
      return () => {
        Reflect.deleteProperty(textarea, "focus");
        Reflect.deleteProperty(textarea, "blur");
        textarea.inert = false;
      };
    },
  };
}
