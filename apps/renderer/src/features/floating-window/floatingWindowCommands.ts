/**
 * in-app undock パネル向けコマンドの配線と context key の同期。
 *
 * close は持たない。Cmd+W / ESC は種類によらず「フォーカスがあるサーフェスを閉じる」1 コマンドに
 * 集約されており (`surface.closeFocused`)、パネルもそのサーフェスの 1 つとして
 * `useSurface` で close の宛先を登録する。
 *
 * save だけはフォーカスで宛先を決める。Cmd+S は「今編集しているものを保存する」意味論で、
 * 重ね順ではなく入力先が対象を決めるため。child window (`childWindowCommands`) と同型に
 * 「フォーカス中のパネル」を追跡し、`floatingWindowFocused` context key と対象ハンドルを
 * 同じ場所で同時に更新する。
 *
 * コマンドはモジュール初期化時に一度だけ登録する (FloatingWindow の import で連れられて
 * 登録される。条件の floatingWindowFocused はパネルの存在を含意するため、useCommandRegistry の
 * fail-loud 不変条件「条件が真なら command は登録済み」を満たす)。
 */
import { useCommandRegistry, useContextKeys } from "../../shared/command";

/** フォーカス中の in-app パネルの操作口。コマンド実行時の対象解決に使う。 */
export interface FloatingWindowHandle {
  /** save 要求。保存対象を持たないパネル (log 等) では no-op */
  requestSave: () => void;
}

const contextKeys = useContextKeys();

let active: FloatingWindowHandle | undefined;

export function activateFloatingWindow(handle: FloatingWindowHandle): void {
  active = handle;
  contextKeys.set("floatingWindowFocused", true);
}

/** handle が active のときだけ解除する (別パネルへの focus 移動で上書き済みなら no-op)。 */
export function deactivateFloatingWindow(handle: FloatingWindowHandle): void {
  if (active !== handle) return;
  active = undefined;
  contextKeys.set("floatingWindowFocused", false);
}

const { register } = useCommandRegistry();

register("floatingWindow.save", {
  label: "Floating Window: Save",
  precondition: "floatingWindowFocused",
  keybinding: { key: "cmd+s", when: "!childWindowFocused" },
  handler: () => {
    if (active === undefined) return false;
    active.requestSave();
    return true;
  },
});
