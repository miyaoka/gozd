/**
 * Keybinding システム。App.vue で1回だけ呼び出す。
 * document の keydown を capture phase で listen し、
 * keybinding テーブルと照合してコマンドを実行する。
 * useEventListener により、コンポーネントの unmount 時に自動解除される。
 */
import { useEventListener } from "@vueuse/core";
import DEFAULT_KEY_BINDINGS from "./defaultKeyBindings.json";
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
}

/** macOS 予約キー（コマンドシステムで横取りしない）。e.code 値で指定 */
const MAC_RESERVED_CODES = new Set([
  "KeyC",
  "KeyV",
  "KeyX",
  "KeyA",
  "KeyZ",
  "KeyQ",
  "KeyH",
  "KeyM",
  "Comma",
]);

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
    };
  });
}

/**
 * キーイベントをコマンドシステムで処理すべきか判定する。
 * false を返した場合はブラウザ/OS のデフォルト動作に委ねる。
 */
function shouldHandle(e: KeyboardEvent): boolean {
  // 他の capture listener が既に処理済み
  if (e.defaultPrevented) return false;

  // 日本語入力中の誤発火防止
  if (e.isComposing) return false;

  // 構造変更コマンドの連打防止
  if (e.repeat) return false;

  const contextKeys = useContextKeys();

  // xterm は内部 textarea にフォーカスを持つが、ターミナルフォーカス時は
  // input/textarea 除外をスキップしてショートカットを有効にする
  if (!contextKeys.get("terminalFocus")) {
    const target = e.target;
    if (target instanceof HTMLElement) {
      const tagName = target.tagName;
      if (tagName === "INPUT" || tagName === "TEXTAREA") return false;
      if (target.isContentEditable) return false;
    }
  }

  // macOS 予約キー（Cmd+C/V/X/A/Z/Q/H/M/,）は OS に委ねる
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (MAC_RESERVED_CODES.has(e.code)) return false;
  }

  return true;
}

export function useKeyBindings() {
  const registry = useCommandRegistry();
  const contextKeys = useContextKeys();

  // default + user（将来）を concat して resolve
  const resolved = resolveBindings(DEFAULT_KEY_BINDINGS);

  useEventListener(
    document,
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

        const handled = registry.execute(binding.command);
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
