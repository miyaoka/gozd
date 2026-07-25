// floating-window feature の公開 API。
//
// 「一時 UI (popover / pane) の表示中コンテンツを独立ウィンドウへ切り離す」機構が複数 feature
// (session-log / preview) にまたがるため、ウィンドウシェルと状態管理 factory を独立 feature
// として切り出している。何を undock するか (payload とヘッダ / 本文の描画) は各 consumer 側に
// 閉じる。
//
// consumer が触るのは UndockedWindow (in-app パネル ⇄ 昇格後の OS ウィンドウを切り替える単一の
// シェル) と store factory だけで、内部の 2 presentation (FloatingWindow / ChildWindow) は
// feature の外に出さない。
export { default as UndockedWindow } from "./UndockedWindow.vue";
export type { UndockDragHandoff } from "./undockDrag";
export {
  closeFrontFloatingWindow,
  createFloatingWindows,
  type FloatingWindowState,
  hasFloatingWindow,
} from "./useFloatingWindows";
