/**
 * Keybinding システム。解決系 (binding テーブル + context key 評価 + command registry) は
 * 単一で、keydown listener だけを各ウィンドウの document に張る (VS Code が
 * onDidRegisterWindow で全ウィンドウに同一 dispatcher を張るのと同じ構造)。
 *
 * - main window: App.vue が `useKeyBindings()` を 1 回だけ呼ぶ
 * - child window (undock 等): 生成側コンポーネントが `useWindowKeyBindings(win)` を呼ぶ。
 *   listener の寿命は呼び出しコンポーネントの effect scope に載り、unmount で自動解除される
 *
 * child window 由来のキーも同じ binding テーブルで解決されるため、child 固有の割り当ては
 * when 条件 (childWindowFocused) で分岐し、テーブル末尾 (高優先) に置く。
 */
import { useEventListener } from "@vueuse/core";
import DEFAULT_KEY_BINDINGS from "./defaultKeyBindings.json";
import { isIMEActive } from "./isIMEActive";
import { eventToKeyStroke, matchKeyStroke, parseKeyStroke } from "./parseKeyStroke";
import { parseWhen } from "./parseWhen";
import type { KeyBinding, KeyStroke, When } from "./types";
import { useCommandRegistry } from "./useCommandRegistry";
import { useContextKeys } from "./useContextKeys";

/** parse 済みの keybinding エントリ */
interface ResolvedBinding {
  stroke: KeyStroke;
  command: string;
  /** unbind エントリ（"-" prefix）か */
  isUnbind: boolean;
  /** unbind の場合、打ち消し対象のコマンド ID（"-" を除いたもの） */
  unbindTarget: string;
  when: When | undefined;
  /** コマンドハンドラーに渡す引数 */
  args: unknown;
}

/** keybinding テーブルを parse して ResolvedBinding 配列にする */
function resolveBindings(bindings: KeyBinding[]): ResolvedBinding[] {
  return bindings.map((b) => {
    const isUnbind = b.command.startsWith("-");
    const command = isUnbind ? b.command.slice(1) : b.command;
    return {
      stroke: parseKeyStroke(b.key),
      command,
      isUnbind,
      unbindTarget: isUnbind ? command : "",
      when: parseWhen(b.when),
      args: b.args,
    };
  });
}

/**
 * キーイベントをコマンドシステムで処理すべきか判定する。
 * false を返した場合はブラウザ/OS のデフォルト動作に委ねる。
 *
 * 一致する binding が無い場合は matching ループ側で素通りし `preventDefault` を呼ばないため、
 * ブラウザ既定 (Cmd+C のコピー等) は自然に動く。よって個別キーをここで予約する必要は無い。
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

// default + user（将来）を concat して resolve。全ウィンドウ共有の単一テーブル
const resolved = resolveBindings(DEFAULT_KEY_BINDINGS);

/** 1 ウィンドウ分の listener 一式を張る。解決系はモジュール単位の共有 (docstring 参照) */
function attachListeners(doc: Document) {
  const registry = useCommandRegistry();
  const contextKeys = useContextKeys();

  // inputFocused context key をフォーカス変化で更新
  useEventListener(doc, "focusin", (e: FocusEvent) => {
    contextKeys.set("inputFocused", isEditableElement(e.target));
  });
  useEventListener(doc, "focusout", () => {
    contextKeys.set("inputFocused", false);
  });

  useEventListener(
    doc,
    "keydown",
    (e: KeyboardEvent) => {
      if (!shouldHandle(e)) return;

      const stroke = eventToKeyStroke(e);

      // unbind で打ち消されたコマンドを追跡する
      const unboundCommands = new Set<string>();

      // 末尾から逆順走査（後のエントリが優先）
      for (let i = resolved.length - 1; i >= 0; i--) {
        const binding = resolved[i];

        if (!matchKeyStroke(stroke, binding.stroke)) continue;
        if (!contextKeys.evaluate(binding.when)) continue;

        if (binding.isUnbind) {
          // unbind: 打ち消し対象を記録して走査を継続
          unboundCommands.add(binding.unbindTarget);
          continue;
        }

        // 通常コマンド: unbind されていなければ実行
        if (unboundCommands.has(binding.command)) continue;

        const handled = registry.execute(binding.command, binding.args);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    },
    { capture: true },
  );
}

/** main window の keybinding 配線。App.vue で 1 回だけ呼ぶ */
export function useKeyBindings() {
  attachListeners(document);
}

/** child window の keybinding 配線。ウィンドウ生成側コンポーネントの setup で呼ぶ */
export function useWindowKeyBindings(win: Window) {
  attachListeners(win.document);
}
