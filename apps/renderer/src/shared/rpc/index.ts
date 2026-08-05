// transport と、層をまたいで単一であるべきものだけを公開する。feature 固有の RPC wrapper は
// 各 feature の rpc.ts に置く。
//
// 外部リンクを開く判断（起動とみなすクリック / OS へ渡す経路 / 失敗の文言）が例外として
// ここに集まるのは、層ごとに持つと同じ操作でも押した場所で挙動が変わるため。
export { rpc } from "./client";
export { isLinkActivation, LINK_OPEN_FAILED_MESSAGE, openExternal } from "./openExternal";
export {
  dispatchMessage,
  initRpcDispatcher,
  onMessage,
  setListenerErrorReporter,
} from "./messages";
