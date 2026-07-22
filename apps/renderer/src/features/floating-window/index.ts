// floating-window feature の公開 API。
//
// 「一時 UI (popover / pane) の表示中コンテンツをドラッグで独立フローティングウィンドウへ
// 昇格させる」機構が複数 feature にまたがる (session-log の undocked log / preview の
// undocked preview) ため、汎用シェルと状態管理 factory を独立 feature として切り出している。
// 何を undock するか (payload とヘッダ / 本文の描画) は各 consumer 側に閉じる。
export { default as FloatingWindow } from "./FloatingWindow.vue";
export {
  closeFrontFloatingWindow,
  createFloatingWindows,
  type FloatingWindowState,
  hasFloatingWindow,
  type UndockDragHandoff,
} from "./useFloatingWindows";
