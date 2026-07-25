// floating-window feature の公開 API。
//
// 「一時 UI (popover / pane) の表示中コンテンツを独立ウィンドウへ切り離す」機構が複数 feature
// (session-log / preview) にまたがるため、ウィンドウシェルと状態管理 factory を独立 feature
// として切り出している。何を undock するか (payload とヘッダ / 本文の描画) は各 consumer 側に
// 閉じる。
//
// consumer が触るのは UndockedWindow (in-app パネル → 昇格後の OS ウィンドウという一方向の
// 切り替えを担う単一のシェル) と store factory だけで、内部の 2 presentation
// (FloatingWindow / ChildWindow)、コマンド配線、context key の同期は feature の外に出さない。
export { default as UndockedWindow } from "./UndockedWindow.vue";
export {
  createFloatingWindows,
  type FloatingWindowState,
  type UndockDragHandoff,
} from "./useFloatingWindows";
