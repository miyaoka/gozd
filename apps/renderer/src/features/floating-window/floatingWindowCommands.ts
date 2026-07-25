/**
 * in-app undock パネル向けコマンドの配線と context key の同期。
 *
 * keybinding の解決系は全ウィンドウ共有 (shared/command) で、同じ Cmd+W / Cmd+S に複数の宛先
 * (terminal pane / preview popover / undock パネル / child window) が並ぶ。解決に優先順位は
 * 無く実効条件で排他にする契約なので、宛先を決めるのは**フォーカス**という規律を in-app パネル
 * にも入れる: child window (`childWindowCommands`) と同型に「フォーカス中のパネル」を追跡し、
 * `floatingWindowFocused` context key と対象ハンドルを同じ場所で同時に更新する。これが無いと
 * パネルにフォーカスがあっても Cmd+W が popover を閉じ、Cmd+S が popover 側のファイルを保存する。
 *
 * `floatingWindow.closeFront` はどのパネルもフォーカスを持たないとき (undock 直後など) の経路と
 * して残す。`floatingWindowVisible` はその条件の source。
 *
 * コマンドはモジュール初期化時に一度だけ登録する (FloatingWindow の import で連れられて
 * 登録される。条件の floatingWindowFocused / floatingWindowVisible はパネルの存在を含意する
 * ため、useCommandRegistry の fail-loud 不変条件「条件が真なら command は登録済み」を満たす)。
 */
import { watch } from "vue";
import { useCommandRegistry, useContextKeys } from "../../shared/command";
import { closeFrontFloatingWindow, hasFloatingWindow } from "./useFloatingWindows";

/** フォーカス中の in-app パネルの操作口。コマンド実行時の対象解決に使う。 */
export interface FloatingWindowHandle {
  /** close 要求。dirty ガード等の可否判断は consumer 側の契約に従う */
  requestClose: () => void;
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

// パネルの有無を closeFront の when 条件へ同期する。module スコープの watch は dispose しない
// (store 自体が module singleton で、アプリの寿命と一致するため)
watch(
  hasFloatingWindow,
  (has) => {
    contextKeys.set("floatingWindowVisible", has);
  },
  { immediate: true },
);

const { register } = useCommandRegistry();

register("floatingWindow.close", {
  label: "Floating Window: Close",
  precondition: "floatingWindowFocused",
  // Cmd+W は他サーフェスと共有するキー。precondition との AND で実効条件になるため
  // floatingWindowFocused は再掲せず、排他のための除外だけを書く
  keybinding: { key: "cmd+w", when: "!childWindowFocused" },
  handler: () => {
    if (active === undefined) return false;
    active.requestClose();
    return true;
  },
});

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

register("floatingWindow.closeFront", {
  label: "Floating Window: Close Front",
  precondition: "floatingWindowVisible",
  // フォーカスを持つサーフェスが Cmd+W を主張していないときだけ最前面パネルを閉じる
  keybinding: {
    key: "cmd+w",
    when: "!floatingWindowFocused && !terminalFocus && !previewVisible && !childWindowFocused",
  },
  handler: () => closeFrontFloatingWindow(),
});
