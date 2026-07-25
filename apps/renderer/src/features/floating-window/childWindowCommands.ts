/**
 * child window (別 OS ウィンドウ) 向けコマンドの配線。
 *
 * keybinding の解決系は全ウィンドウ共有 (shared/command) なので、child 固有の割り当ては
 * `childWindowFocused` context key で分岐する。コマンドの対象は「フォーカスされている
 * child window」で、各 ChildWindow が OS の focus / blur を activate / deactivate に変換して
 * ここのハンドルを更新する。context key と対象ハンドルを同じ場所で同時に更新することで、
 * 「条件は真なのに対象がいない」ずれを構造的に防ぐ。
 *
 * コマンドはモジュール初期化時に一度だけ登録する (ChildWindow の import で連れられて登録
 * される)。Cmd+W / Cmd+S は main window 側と同じキーで、あちらの同キー割り当てが
 * `!childWindowFocused` を持つことで実効条件が排他になる。
 */
import { useCommandRegistry, useContextKeys } from "../../shared/command";

/** フォーカス中の child window の操作口。コマンド実行時の対象解決に使う。 */
export interface ChildWindowHandle {
  /** close 要求。dirty ガード等の可否判断は ChildWindow / consumer 側の契約に従う */
  requestClose: () => void;
  /** save 要求。保存対象を持たない window では no-op */
  requestSave: () => void;
}

const contextKeys = useContextKeys();

let active: ChildWindowHandle | undefined;

export function activateChildWindow(handle: ChildWindowHandle): void {
  active = handle;
  contextKeys.set("childWindowFocused", true);
}

/** handle が active のときだけ解除する (別 window への focus 移動で上書き済みなら no-op)。 */
export function deactivateChildWindow(handle: ChildWindowHandle): void {
  if (active !== handle) return;
  active = undefined;
  contextKeys.set("childWindowFocused", false);
}

const { register } = useCommandRegistry();

register("childWindow.close", {
  label: "Child Window: Close",
  precondition: "childWindowFocused",
  // when は precondition との AND で効くため childWindowFocused を再掲しない
  keybinding: { key: "cmd+w" },
  handler: () => {
    if (active === undefined) return false;
    active.requestClose();
    return true;
  },
});

register("childWindow.save", {
  label: "Child Window: Save",
  precondition: "childWindowFocused",
  keybinding: { key: "cmd+s" },
  handler: () => {
    if (active === undefined) return false;
    active.requestSave();
    return true;
  },
});
