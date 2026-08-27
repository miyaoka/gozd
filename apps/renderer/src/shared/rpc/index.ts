// transport と、層をまたいで単一であるべきものだけを公開する。単一 feature 専用の
// RPC wrapper はその feature の rpc.ts に置き、複数 feature が共有する wrapper と
// push payload 契約（appConfig の直列化キュー、fs watch）はここに置く。
//
// 外部リンクを開く判断（起動とみなすクリック / OS へ渡す経路 / 失敗の文言）が例外として
// ここに集まるのは、層ごとに持つと同じ操作でも押した場所で挙動が変わるため。
export { rpcLoadAppConfig, updateAppConfig } from "./appConfig";
export { rpc } from "./client";
export { rpcFsUnwatch, rpcFsUnwatchAll, rpcFsWatch } from "./fs";
export type { FsWatchReadyPayload } from "./fs";
export { isLinkActivation, openExternalOrNotify } from "./openExternal";
export {
  dispatchMessage,
  initRpcDispatcher,
  onMessage,
  setListenerErrorReporter,
  setUndeliveredReporter,
} from "./messages";
