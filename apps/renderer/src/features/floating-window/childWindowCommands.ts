/**
 * child window (別 OS ウィンドウ) 向けコマンドの配線。
 *
 * keybinding の解決系は全ウィンドウ共有の単一テーブル (shared/command) なので、child 固有の
 * 割り当ては `childWindowFocused` context key の when 条件で分岐する。コマンドの対象は
 * 「フォーカスされている child window」で、各 ChildWindow が OS の focus / blur を
 * activate / deactivate に変換してここのハンドルを更新する。context key と対象ハンドルを
 * 同じ場所で同時に更新することで、「when は真なのに対象がいない」ずれを構造的に防ぐ。
 *
 * コマンドはモジュール初期化時に一度だけ登録する (ChildWindow の import で連れられて登録
 * される。keybinding の when = childWindowFocused が ChildWindow の存在を含意するため、
 * useCommandRegistry の fail-loud 不変条件「when が真なら command は登録済み」を満たす)。
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
  handler: () => {
    if (active === undefined) return false;
    active.requestClose();
    return true;
  },
});

register("childWindow.save", {
  label: "Child Window: Save",
  precondition: "childWindowFocused",
  handler: () => {
    if (active === undefined) return false;
    active.requestSave();
    return true;
  },
});
