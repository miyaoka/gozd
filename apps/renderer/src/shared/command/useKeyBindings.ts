/**
 * Keybinding システム。解決系 (command registry + context key 評価) は単一で、keydown listener
 * だけを各ウィンドウの document に張る (VS Code が onDidRegisterWindow で全ウィンドウに同一
 * dispatcher を張るのと同じ構造)。
 *
 * - main window: App.vue が `useKeyBindings()` を 1 回だけ呼ぶ
 * - child window (undock 等): 生成側コンポーネントが `useWindowKeyBindings(win)` を呼ぶ。
 *   listener の寿命は呼び出しコンポーネントの effect scope に載り、unmount で自動解除される
 *
 * 既定 keybinding は独立したテーブルではなく `register()` の記述子に同居するため、キーの解決先は
 * registry (`resolveKeyBinding`) であり、コマンド ID を突き合わせる第 2 のテーブルは無い。
 * child window 由来のキーも同じ registry で解決されるため、child 固有の割り当ては
 * childWindowFocused の条件で分岐する (docs/keybinding.md)。
 *
 * ## 解決フェーズ
 *
 * 既定は capture だが、**Escape だけは bubble** で解決する。
 *
 * VS Code の dispatcher は全キーを bubble で解決し、内側 (Monaco) との排他は context key +
 * weight で書く (`closeFindWidget` は `precondition: CONTEXT_FIND_WIDGET_VISIBLE` /
 * `kbExpr: EditorContextKeys.focus` / `weight: EditorContrib + 5`)。これが成立するのは
 * Monaco の割り当てが**同じ registry に載っている**ため。gozd が埋め込む Monaco は自前の
 * keybinding service を持ち本 registry の外にいるので、同じ手は使えない。
 *
 * 代わりに「内側が処理したら譲る」を DOM のフェーズと `defaultPrevented` で表現する。Escape は
 * Monaco の find widget / suggest が消費して `preventDefault` するキーで、capture で奪うと
 * widget を閉じるつもりの Escape がサーフェスごと閉じる。bubble なら `shouldHandle` の
 * `defaultPrevented` 判定で内側に譲れる。
 *
 * Escape 以外を capture のままにするのは、それが既存の挙動だから。Cmd 系を内側より先に取る
 * 必要があるかは本 module の関心の外で、変えるなら別途 xterm / Monaco の消費キーを実測する。
 *
 * フェーズをキーごとの宣言 (`KeyBindingSpec`) に開かないのは、書き忘れが必ず出るため。
 * 「内側が先に取るキーか」はキーの性質であってコマンドの都合ではないので dispatcher が決める。
 */
import { useEventListener } from "@vueuse/core";
import { isIMEActive } from "./isIMEActive";
import { eventToKeyStroke } from "./parseKeyStroke";
import { useCommandRegistry } from "./useCommandRegistry";
import { useContextKeys } from "./useContextKeys";

/**
 * キーイベントをコマンドシステムで処理すべきか判定する。
 * false を返した場合はブラウザ/OS のデフォルト動作に委ねる。
 *
 * 一致する binding が無い場合は照合で素通りし `preventDefault` を呼ばないため、ブラウザ既定
 * (Cmd+C のコピー等) は自然に動く。よって個別キーをここで予約する必要は無い。
 */
function shouldHandle(e: KeyboardEvent): boolean {
  // 他の capture listener が既に処理済み
  if (e.defaultPrevented) return false;

  // 日本語入力中の誤発火防止
  if (isIMEActive(e)) return false;

  // 構造変更コマンドの連打防止
  if (e.repeat) return false;

  return true;
}

/** フォーカス対象が editable 要素か判定する */
function isEditableElement(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  return el.isContentEditable;
}

/**
 * bubble フェーズで解決するキー (docstring の「解決フェーズ」参照)。
 * `KeyStroke.code` の値で持つ。
 */
const BUBBLE_PHASE_CODES = new Set(["Escape"]);

/** 1 ウィンドウ分の listener 一式を張る。解決系はモジュール単位の共有 (docstring 参照) */
function attachListeners(doc: Document) {
  const registry = useCommandRegistry();
  const contextKeys = useContextKeys();

  const dispatch = (e: KeyboardEvent, bubble: boolean) => {
    if (!shouldHandle(e)) return;

    const stroke = eventToKeyStroke(e);
    // 自分のフェーズでないキーは相手側の listener に任せる
    if (BUBBLE_PHASE_CODES.has(stroke.code) !== bubble) return;

    // inputFocused は「keydown を受けた document のフォーカス状態」を評価直前に写す。
    // focusin / focusout で共有 state を先回り更新する方式だと、非アクティブな別ウィンドウの
    // フォーカスイベントが発火元ウィンドウの when 判定を上書きしうる (ウィンドウ間の混線)。
    // 消費者は keybinding の when 節のみで、この key が意味を持つのはディスパッチの
    // 瞬間だけなので、都度読み取るだけで十分かつ常に正しい
    contextKeys.set("inputFocused", isEditableElement(doc.activeElement));

    const entry = registry.resolveKeyBinding(stroke);

    // bind 無し: preventDefault しないのでブラウザ既定 (Cmd+C のコピー等) がそのまま動く
    if (entry === undefined) return;

    const handled = registry.execute(entry.id);
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  useEventListener(doc, "keydown", (e: KeyboardEvent) => dispatch(e, false), { capture: true });
  useEventListener(doc, "keydown", (e: KeyboardEvent) => dispatch(e, true));
}

/** main window の keybinding 配線。App.vue で 1 回だけ呼ぶ */
export function useKeyBindings() {
  attachListeners(document);
}

/** child window の keybinding 配線。ウィンドウ生成側コンポーネントの setup で呼ぶ */
export function useWindowKeyBindings(win: Window) {
  attachListeners(win.document);
}
