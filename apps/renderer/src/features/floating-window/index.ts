// floating-window feature の公開 API。
//
// 「一時 UI (popover / pane) の表示中コンテンツを独立ウィンドウへ昇格させる」機構が
// 複数 feature にまたがるため、汎用シェルと状態管理 factory を独立 feature として
// 切り出している。何を undock するか (payload とヘッダ / 本文の描画) は各 consumer 側に
// 閉じる。シェルは 2 種:
// - FloatingWindow: アプリ画面内の in-app フローティングパネル (session-log が使用)
// - ChildWindow: 別 OS ウィンドウ (Electron child window。preview が使用)
export { default as ChildWindow } from "./ChildWindow.vue";
export { default as FloatingWindow } from "./FloatingWindow.vue";
export {
  closeFrontFloatingWindow,
  createFloatingWindows,
  type FloatingWindowState,
  hasFloatingWindow,
  type UndockDragHandoff,
} from "./useFloatingWindows";
