// floating-window feature の公開 API。
//
// 「一時 UI (popover / pane) の表示中コンテンツを独立ウィンドウへ昇格させる」機構が
// 複数 feature (session-log / preview) にまたがるため、汎用シェル ChildWindow
// (別 OS ウィンドウ = Electron child window) と状態管理 factory を独立 feature として
// 切り出している。何を undock するか (payload とヘッダ / 本文の描画) は各 consumer 側に閉じる。
export { default as ChildWindow } from "./ChildWindow.vue";
export { rpcChildWindowResizeBy } from "./rpc";
export {
  type ChildWindowInit,
  createChildWindows,
  type UndockDragHandoff,
} from "./useChildWindows";
